import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decrypt, encryptBlob, isEncrypted, type StorageKey } from './crypto.js';
import { readKey } from './encryption.js';

/**
 * Entry points git runs in an encrypted storage (configured by `installFilters`):
 * the long-running clean/smudge filter, the diff textconv and the merge driver.
 * They talk to git over stdout, so they never print anything else there.
 */

const MAX_PACKET = 65516;
const FLUSH = Buffer.from('0000');

function packet(data: Buffer | string): Buffer {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

/** Reads pkt-lines (git's framing: 4 hex digits of length, then data; `0000` is a flush). */
class PacketReader {
  private buf = Buffer.alloc(0);
  private readonly chunks: AsyncIterator<Buffer>;

  constructor(stream: NodeJS.ReadableStream) {
    this.chunks = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      const next = await this.chunks.next();
      if (next.done) return false;
      this.buf = Buffer.concat([this.buf, next.value]);
    }
    return true;
  }

  /** A data packet, null for a flush, undefined at the end of input. */
  async read(): Promise<Buffer | null | undefined> {
    if (!(await this.fill(4))) return undefined;
    const len = parseInt(this.buf.subarray(0, 4).toString('latin1'), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4)) throw new Error('bad pkt-line from git');
    if (len === 0) {
      this.buf = this.buf.subarray(4);
      return null;
    }
    if (!(await this.fill(len))) throw new Error('truncated pkt-line from git');
    const data = this.buf.subarray(4, len);
    this.buf = this.buf.subarray(len);
    return data;
  }

  /** Text lines up to a flush; undefined at the end of input. */
  async readList(): Promise<string[] | undefined> {
    const lines: string[] = [];
    for (;;) {
      const p = await this.read();
      if (p === undefined) {
        if (lines.length) throw new Error('truncated message from git');
        return undefined;
      }
      if (p === null) return lines;
      lines.push(p.toString('utf8').replace(/\n$/, ''));
    }
  }

  async readContent(): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (;;) {
      const p = await this.read();
      if (p === undefined) throw new Error('truncated content from git');
      if (p === null) return Buffer.concat(parts);
      parts.push(p);
    }
  }
}

function write(data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write(data, (err) => (err ? reject(err) : resolve())));
}

function contentPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += MAX_PACKET) out.push(packet(data.subarray(i, i + MAX_PACKET)));
  return out;
}

function transform(command: string, data: Buffer, key: StorageKey | null): Buffer {
  if (command === 'clean') {
    if (isEncrypted(data)) return data;
    if (!key) throw new Error('no key on this machine, refusing to store the file unencrypted (run `doku unlock`)');
    return encryptBlob(key, data);
  }
  if (command === 'smudge') {
    if (!isEncrypted(data)) return data;
    if (!key) throw new Error('no key on this machine to decrypt it (run `doku unlock`)');
    return decrypt(key, data);
  }
  throw new Error(`unsupported filter command ${command}`);
}

/** git's long-running filter protocol, version 2 (see gitattributes(5), "Long Running Filter Process"). */
export async function runFilterProcess(): Promise<void> {
  const reader = new PacketReader(process.stdin);
  const hello = await reader.readList();
  if (hello?.[0] !== 'git-filter-client' || !hello.includes('version=2')) throw new Error('unexpected filter handshake from git');
  await write(Buffer.concat([packet('git-filter-server\n'), packet('version=2\n'), FLUSH]));
  const offered = (await reader.readList()) ?? [];
  const caps = ['clean', 'smudge'].filter((c) => offered.includes(`capability=${c}`));
  await write(Buffer.concat([...caps.map((c) => packet(`capability=${c}\n`)), FLUSH]));

  let key: StorageKey | null | undefined;
  for (;;) {
    const header = await reader.readList();
    if (header === undefined) return;
    const fields = new Map(header.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const content = await reader.readContent();
    let out: Buffer;
    try {
      if (key === undefined) key = readKey(process.cwd());
      out = transform(fields.get('command') ?? '', content, key);
    } catch (err) {
      process.stderr.write(`doku: ${fields.get('pathname')}: ${(err as Error).message}\n`);
      await write(Buffer.concat([packet('status=error\n'), FLUSH]));
      continue;
    }
    await write(Buffer.concat([packet('status=success\n'), FLUSH, ...contentPackets(out), FLUSH, FLUSH]));
  }
}

function keyOrNull(): StorageKey | null {
  try {
    return readKey(process.cwd());
  } catch {
    return null;
  }
}

/** `git diff` / `git log -p` show plaintext: git hands us a file with a blob's content. */
export function runTextconv(file: string): void {
  const data = fs.readFileSync(file);
  const key = isEncrypted(data) ? keyOrNull() : null;
  let out: Buffer = data;
  if (key) {
    try {
      out = decrypt(key, data);
    } catch (err) {
      out = Buffer.from(`[doku: cannot decrypt: ${(err as Error).message}]\n`);
    }
  }
  fs.writeSync(1, out);
}

/**
 * Merge driver: decrypt base, ours and theirs, merge them as text with `git merge-file`,
 * and write the result (encrypted again) to `ours`. Returns 0 when clean, 1 on conflicts;
 * the conflict markers then show in the decrypted file like in any other merge.
 */
export function runMergeDriver(base: string, ours: string, theirs: string, markerSize = '7'): number {
  const key = keyOrNull();
  const open = (f: string) => {
    const data = fs.readFileSync(f);
    if (!isEncrypted(data)) return data;
    if (!key) throw new Error('no key on this machine to merge encrypted files (run `doku unlock`)');
    return decrypt(key, data);
  };
  const versions = [ours, base, theirs].map(open);
  if (versions.some((v) => v.includes(0))) return 1; // binary: keep ours, report a conflict

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doku-merge-'));
  try {
    const [a, o, b] = ['ours', 'base', 'theirs'].map((name, i) => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, versions[i]);
      return f;
    });
    const res = spawnSync('git', ['merge-file', `--marker-size=${markerSize}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', a, o, b]);
    if (res.error || res.status === null || res.status < 0 || res.status > 127) {
      process.stderr.write(`doku: git merge-file failed: ${res.error?.message ?? res.stderr.toString()}\n`);
      return 2;
    }
    const merged = fs.readFileSync(a);
    fs.writeFileSync(ours, key ? encryptBlob(key, merged) : merged);
    return res.status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
