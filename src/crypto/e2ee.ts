/**
 * Cross-platform End-to-End Encryption (E2EE) using Web Crypto API.
 * Uses PBKDF2 (600,000 iterations of SHA-256) + AES-256-GCM.
 * File format: [MAGIC: 12 bytes] + [SALT: 16 bytes] + [IV: 12 bytes] + [CIPHERTEXT + TAG]
 * 
 * Inspired by and compatible with owl234/obsidian-baidu-netdisk-sync
 */

const MAGIC_HEADER = new Uint8Array([
  0x42, 0x44, 0x53, 0x59, 0x4e, 0x43, 0x5f, 0x45, 0x32, 0x45, 0x45, 0x01,
]); // "BDSYNC_E2EE\x01"

export const PBKDF2_ITERATIONS = 600000;
export const LEGACY_PBKDF2_ITERATIONS = 100000;

export function isEncrypted(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < MAGIC_HEADER.length + 16 + 12 + 16) {
    return false;
  }
  const view = new Uint8Array(buffer, 0, MAGIC_HEADER.length);
  for (let i = 0; i < MAGIC_HEADER.length; i++) {
    if (view[i] !== MAGIC_HEADER[i]) {
      return false;
    }
  }
  return true;
}

function getCrypto(): Crypto {
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  if (typeof globalThis !== "undefined" && globalThis.crypto) {
    return globalThis.crypto;
  }
  return crypto;
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const c = getCrypto();
  const keyMaterial = await c.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return c.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptData(
  data: ArrayBuffer,
  password: string
): Promise<ArrayBuffer> {
  const c = getCrypto();
  const salt = c.getRandomValues(new Uint8Array(16));
  const iv = c.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const ciphertext = await c.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    data
  );

  const totalLength =
    MAGIC_HEADER.length + salt.length + iv.length + ciphertext.byteLength;
  const result = new Uint8Array(totalLength);

  let offset = 0;
  result.set(MAGIC_HEADER, offset);
  offset += MAGIC_HEADER.length;

  result.set(salt, offset);
  offset += salt.length;

  result.set(iv, offset);
  offset += iv.length;

  result.set(new Uint8Array(ciphertext), offset);

  return result.buffer;
}

export async function decryptData(
  encryptedBuffer: ArrayBuffer,
  password: string
): Promise<ArrayBuffer> {
  if (!isEncrypted(encryptedBuffer)) {
    // If not encrypted, return raw data directly
    return encryptedBuffer;
  }

  let offset = MAGIC_HEADER.length;
  const salt = new Uint8Array(encryptedBuffer, offset, 16);
  offset += 16;

  const iv = new Uint8Array(encryptedBuffer, offset, 12);
  offset += 12;

  const ciphertext = encryptedBuffer.slice(offset);
  const c = getCrypto();

  // Try standard PBKDF2 iterations first
  try {
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    return await c.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      ciphertext
    );
  } catch (err) {
    // Fallback to legacy iterations if applicable
    try {
      const legacyKey = await deriveKey(password, salt, LEGACY_PBKDF2_ITERATIONS);
      return await c.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        legacyKey,
        ciphertext
      );
    } catch {
      throw new Error("解密失败：E2EE 端到端解密密码错误或数据已损坏！");
    }
  }
}
