/**
 * Crypto and encoding primitives for the MitID / OAuth flow. Thin wrappers over
 * node:crypto so the protocol code reads like the wire spec.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';

export { randomBytes };

export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

export function hmacSha256(key: Buffer | string, data: Buffer | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function pbkdf2Sha256(password: string, salt: Buffer, iterations: number, length: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, length, 'sha256');
}

/** AES-256-GCM with a 16-byte tag. Returns `iv || ciphertext || tag`. */
export function aesGcmSeal(key: Buffer, plaintext: Buffer, ivLength = 16): Buffer {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

/** Inverse of {@link aesGcmSeal}. Throws if the tag does not verify. */
export function aesGcmOpen(key: Buffer, sealed: Buffer, ivLength = 16): Buffer {
  if (sealed.length < ivLength + 16) throw new Error('aesGcmOpen: ciphertext too short');
  const iv = sealed.subarray(0, ivLength);
  const tag = sealed.subarray(sealed.length - 16);
  const ciphertext = sealed.subarray(ivLength, sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

export function hexToBigInt(hex: string): bigint {
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

export function bytesToBigInt(buf: Buffer): bigint {
  return hexToBigInt(buf.toString('hex'));
}

/** Unsigned big-endian bytes, left-padded to `length`. */
export function bigIntToBytes(value: bigint, length: number): Buffer {
  if (value < 0n) throw new Error('bigIntToBytes: negative value');
  const hex = value.toString(16).padStart(length * 2, '0');
  if (hex.length > length * 2) throw new Error(`bigIntToBytes: value does not fit in ${length} bytes`);
  return Buffer.from(hex, 'hex');
}

/** RFC 7636 PKCE pair (S256). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(sha256(verifier)) };
}
