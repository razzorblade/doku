import crypto from 'node:crypto';
import { DokuError } from './errors.js';

/**
 * Encryption primitives for an encrypted storage. Only symmetric crypto (AES-256-GCM,
 * HKDF-SHA256, HMAC-SHA256, scrypt), all from node:crypto. With no public-key crypto
 * involved there is nothing a quantum computer breaks: Grover's algorithm leaves a
 * 256-bit key at 128-bit strength.
 */

/** Starts every encrypted blob and zip payload. The NUL makes git and GitHub treat it as binary. */
export const MAGIC = Buffer.from('\0DOKUENC', 'latin1');
const VERSION = 1;
const KEY_LEN = 32;
const ID_LEN = 8;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + ID_LEN + NONCE_LEN;

export const CIPHER = 'AES-256-GCM';

export interface StorageKey {
  /** The 32 random bytes the recovery key encodes. */
  raw: Buffer;
  /** Public fingerprint, stored next to encrypted data to tell keys apart. */
  id: Buffer;
  enc: Buffer;
  nonce: Buffer;
}

function hkdf(raw: Buffer, info: string, len: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.from('doku'), info, len));
}

export function deriveKey(raw: Buffer): StorageKey {
  if (raw.length !== KEY_LEN) throw new DokuError('Invalid key.');
  return {
    raw,
    id: hkdf(raw, 'doku v1 key id', ID_LEN),
    enc: hkdf(raw, 'doku v1 encryption', 32),
    nonce: hkdf(raw, 'doku v1 nonce', 32),
  };
}

export function generateKey(): StorageKey {
  return deriveKey(crypto.randomBytes(KEY_LEN));
}

export function keyIdHex(key: StorageKey): string {
  return key.id.toString('hex');
}

export function isEncrypted(data: Uint8Array): boolean {
  return data.length >= MAGIC.length && Buffer.from(data.buffer, data.byteOffset, MAGIC.length).equals(MAGIC);
}

/** Layout: MAGIC, version, key id, nonce, ciphertext, GCM tag. The header is authenticated too. */
function seal(key: StorageKey, plaintext: Uint8Array, nonce: Buffer): Buffer {
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), key.id, nonce]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.enc, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/**
 * Deterministic encryption for git blobs: the same file always gives the same blob, so
 * git doesn't see unchanged files as modified. The nonce is an HMAC of the content
 * (a synthetic IV, as in git-crypt), so different contents never share a nonce. The only
 * thing it reveals is whether two files are identical.
 */
export function encryptBlob(key: StorageKey, plaintext: Uint8Array): Buffer {
  const nonce = crypto.createHmac('sha256', key.nonce).update(plaintext).digest().subarray(0, NONCE_LEN);
  return seal(key, plaintext, nonce);
}

/** Encryption with a random nonce, for zip payloads. */
export function encryptPayload(key: StorageKey, plaintext: Uint8Array): Buffer {
  return seal(key, plaintext, crypto.randomBytes(NONCE_LEN));
}

/** Key id (hex) that encrypted data was made with, or null for data that isn't encrypted. */
export function keyIdOf(data: Uint8Array): string | null {
  if (!isEncrypted(data) || data.length < HEADER_LEN) return null;
  return Buffer.from(data.subarray(MAGIC.length + 1, MAGIC.length + 1 + ID_LEN)).toString('hex');
}

export function decrypt(key: StorageKey, data: Uint8Array): Buffer {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  if (!isEncrypted(buf) || buf.length < HEADER_LEN + TAG_LEN) throw new DokuError('The data is not encrypted by doku.');
  const version = buf[MAGIC.length];
  if (version !== VERSION) throw new DokuError(`The data was encrypted by a newer doku (format ${version}). Update doku.`);
  if (!buf.subarray(MAGIC.length + 1, MAGIC.length + 1 + ID_LEN).equals(key.id)) {
    throw new DokuError('The data was encrypted with a different key.');
  }
  const header = buf.subarray(0, HEADER_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key.enc, buf.subarray(HEADER_LEN - NONCE_LEN, HEADER_LEN));
  decipher.setAAD(header);
  decipher.setAuthTag(buf.subarray(buf.length - TAG_LEN));
  try {
    return Buffer.concat([decipher.update(buf.subarray(HEADER_LEN, buf.length - TAG_LEN)), decipher.final()]);
  } catch {
    throw new DokuError('The encrypted data is damaged or was tampered with.');
  }
}

// Recovery key: "DOKU1-" + Crockford base32 of the key and a 3-byte checksum, in groups of 8.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'DOKU1';
const CHECK_LEN = 3;

function checksum(raw: Buffer): Buffer {
  return crypto.createHash('sha256').update('doku recovery key').update(raw).digest().subarray(0, CHECK_LEN);
}

function base32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Buffer | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const v = B32.indexOf(ch);
    if (v === -1) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function formatRecoveryKey(key: StorageKey): string {
  const chars = base32(Buffer.concat([key.raw, checksum(key.raw)]));
  return [PREFIX, ...(chars.match(/.{1,8}/g) ?? [])].join('-');
}

export function looksLikeRecoveryKey(text: string): boolean {
  return /^\s*doku1[-\s]/i.test(text);
}

/** Parse a recovery key typed or pasted by the user. Case, spaces and I/L/O mix-ups don't matter. */
export function parseRecoveryKey(text: string): StorageKey {
  let s = text.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!s.startsWith(PREFIX)) throw new DokuError('A recovery key starts with DOKU1-.');
  s = s.slice(PREFIX.length).replace(/[IL]/g, '1').replace(/O/g, '0');
  const bytes = s.length === 56 ? unbase32(s) : null;
  if (!bytes || bytes.length !== KEY_LEN + CHECK_LEN) throw new DokuError('That recovery key is incomplete or has invalid characters.');
  const raw = bytes.subarray(0, KEY_LEN);
  if (!checksum(raw).equals(bytes.subarray(KEY_LEN))) throw new DokuError('That recovery key has a typo (its checksum does not match).');
  return deriveKey(Buffer.from(raw));
}

// Passphrase: scrypt derives a key-encryption key that wraps the storage key.

export interface PassphraseWrap {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
  /** base64: nonce, wrapped key, tag. */
  key: string;
}

export const SCRYPT_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSPHRASE = 12;
const WRAP_AAD = Buffer.from('doku passphrase v1');

function kek(passphrase: string, w: Pick<PassphraseWrap, 'N' | 'r' | 'p' | 'salt'>): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), Buffer.from(w.salt, 'base64'), 32, {
    N: w.N,
    r: w.r,
    p: w.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function wrapKey(key: StorageKey, passphrase: string, params = SCRYPT_DEFAULTS): PassphraseWrap {
  const base = { ...params, salt: crypto.randomBytes(16).toString('base64') };
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek(passphrase, base), nonce);
  cipher.setAAD(WRAP_AAD);
  const body = Buffer.concat([cipher.update(key.raw), cipher.final()]);
  return { kdf: 'scrypt', ...base, key: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64') };
}

/** The storage key, or null for a wrong passphrase. */
export function unwrapKey(w: PassphraseWrap, passphrase: string): StorageKey | null {
  // The parameters come from the repository or a zip: keep them within sane bounds.
  const ok =
    w?.kdf === 'scrypt' &&
    Number.isInteger(w.N) && w.N >= 2 ** 10 && w.N <= 2 ** 20 && (w.N & (w.N - 1)) === 0 &&
    Number.isInteger(w.r) && w.r >= 1 && w.r <= 16 &&
    Number.isInteger(w.p) && w.p >= 1 && w.p <= 4 &&
    typeof w.salt === 'string' && typeof w.key === 'string';
  if (!ok) throw new DokuError('The passphrase settings of this storage are invalid.');
  const blob = Buffer.from(w.key, 'base64');
  if (blob.length !== NONCE_LEN + KEY_LEN + TAG_LEN) throw new DokuError('The passphrase settings of this storage are invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek(passphrase, w), blob.subarray(0, NONCE_LEN));
  decipher.setAAD(WRAP_AAD);
  decipher.setAuthTag(blob.subarray(NONCE_LEN + KEY_LEN));
  try {
    return deriveKey(Buffer.concat([decipher.update(blob.subarray(NONCE_LEN, NONCE_LEN + KEY_LEN)), decipher.final()]));
  } catch {
    return null;
  }
}
