import { describe, expect, it } from 'vitest';
import {
  decrypt,
  encryptBlob,
  encryptPayload,
  formatRecoveryKey,
  generateKey,
  isEncrypted,
  keyIdHex,
  keyIdOf,
  looksLikeRecoveryKey,
  parseRecoveryKey,
  unwrapKey,
  wrapKey,
} from '../src/crypto.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('crypto', () => {
  const key = generateKey();
  const text = Buffer.from('client notes: secret\n');

  it('round-trips blobs and payloads', () => {
    for (const enc of [encryptBlob(key, text), encryptPayload(key, text)]) {
      expect(isEncrypted(enc)).toBe(true);
      expect(enc.includes(Buffer.from('secret'))).toBe(false);
      expect(decrypt(key, enc).equals(text)).toBe(true);
      expect(keyIdOf(enc)).toBe(keyIdHex(key));
    }
    expect(decrypt(key, encryptBlob(key, Buffer.alloc(0))).length).toBe(0);
  });

  it('blob encryption is deterministic, payload encryption is not', () => {
    expect(encryptBlob(key, text).equals(encryptBlob(key, text))).toBe(true);
    expect(encryptBlob(key, text).equals(encryptBlob(key, Buffer.from('client notes: secreT\n')))).toBe(false);
    expect(encryptPayload(key, text).equals(encryptPayload(key, text))).toBe(false);
  });

  it('rejects tampering and other keys', () => {
    const enc = encryptBlob(key, text);
    const flipped = Buffer.from(enc);
    flipped[flipped.length - 20] ^= 1;
    expect(() => decrypt(key, flipped)).toThrow(/damaged or was tampered/);
    const header = Buffer.from(enc);
    header[header.length - text.length - 17] ^= 1; // last nonce byte, which is authenticated
    expect(() => decrypt(key, header)).toThrow(/damaged or was tampered/);
    expect(() => decrypt(generateKey(), enc)).toThrow(/different key/);
    expect(() => decrypt(key, text)).toThrow(/not encrypted/);
  });

  it('formats and parses recovery keys, catching typos', () => {
    const recovery = formatRecoveryKey(key);
    expect(recovery).toMatch(/^DOKU1(-[0-9A-HJKMNP-TV-Z]{8}){7}$/);
    expect(looksLikeRecoveryKey(recovery)).toBe(true);
    expect(looksLikeRecoveryKey('correct horse battery')).toBe(false);
    expect(parseRecoveryKey(recovery).raw.equals(key.raw)).toBe(true);
    // Lower case, spaces instead of dashes, O for 0 and I/L for 1 still parse.
    const body = recovery.slice('DOKU1-'.length);
    const sloppy = 'doku1 ' + body.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    expect(parseRecoveryKey(sloppy).raw.equals(key.raw)).toBe(true);

    const i = recovery.length - 3;
    const typo = recovery.slice(0, i) + (recovery[i] === 'A' ? 'B' : 'A') + recovery.slice(i + 1);
    expect(() => parseRecoveryKey(typo)).toThrow(/typo/);
    expect(() => parseRecoveryKey(recovery.slice(0, -4))).toThrow(/incomplete/);
    expect(() => parseRecoveryKey('hello')).toThrow(/starts with DOKU1/);
  });

  it('wraps the key with a passphrase', () => {
    const wrap = wrapKey(key, 'a long enough passphrase', FAST);
    expect(JSON.stringify(wrap)).not.toContain(key.raw.toString('base64'));
    expect(unwrapKey(wrap, 'a long enough passphrase')!.raw.equals(key.raw)).toBe(true);
    expect(unwrapKey(wrap, 'a long enough passphrasE')).toBeNull();
    expect(() => unwrapKey({ ...wrap, N: 2 ** 30 }, 'x')).toThrow(/invalid/);
  });
});
