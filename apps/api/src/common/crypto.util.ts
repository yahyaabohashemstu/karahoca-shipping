import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM. Layout: nonce(12) ‖ ciphertext ‖ tag(16). */
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Encrypt a driver's per-session HMAC key for storage.
 *
 * We must be able to recover the plaintext (HMAC is symmetric), so a hash will
 * not do. Envelope-encrypting with a key that lives only in the process
 * environment means a stolen database dump alone does not let an attacker forge
 * location points — they would also need the running host's env.
 */
export function encryptSecret(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function decryptSecret(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error('Ciphertext too short to be a valid AES-GCM envelope');
  }
  const nonce = blob.subarray(0, GCM_NONCE_BYTES);
  const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
  const ct = blob.subarray(GCM_NONCE_BYTES, blob.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Canonical string signed by the driver app:
 *
 *     HMAC-SHA256( ingestKey, `${timestamp}.${nonce}.${sha256Hex(rawBody)}` )
 *
 * Binding the body hash means a captured bearer token cannot be replayed with
 * different coordinates; binding the timestamp and nonce means the *same* body
 * cannot be replayed either.
 */
export function ingestSignature(
  ingestKey: Buffer,
  timestamp: string,
  nonce: string,
  rawBody: Buffer,
): string {
  const payload = `${timestamp}.${nonce}.${sha256Hex(rawBody)}`;
  return createHmac('sha256', ingestKey).update(payload).digest('hex');
}

/** Constant-time comparison that never throws on length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Crockford Base32 normalisation, mirroring kh.normalize_claim_code() in SQL so
 * that a code typed as "k7h2-9qx4" (or with an I instead of a 1) resolves the
 * same way on both sides.
 */
export function normalizeClaimCode(input: string): string {
  return (input ?? '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/[O]/g, '0')
    .replace(/[U]/g, '1');
}
