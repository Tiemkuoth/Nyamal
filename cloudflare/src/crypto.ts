import type { Env } from "./types";
import { HttpError } from "./http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const configured = env.NYAMAL_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new HttpError(503, "NYAMAL_ENCRYPTION_KEY must be configured before storing credentials");
  }
  const raw = decodeBase64Url(configured);
  if (raw.byteLength !== 32) {
    throw new HttpError(503, "NYAMAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", copyToArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function encryptSecret(env: Env, value: string): Promise<string> {
  if (!value) throw new Error("Secret cannot be empty");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: copyToArrayBuffer(iv) },
    await encryptionKey(env),
    copyToArrayBuffer(encoder.encode(value)),
  );
  return `v1:${encodeBase64(iv)}:${encodeBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(env: Env, value: string): Promise<string> {
  const [version, encodedIv, encodedCiphertext] = value.split(":");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) {
    throw new Error("Stored credential has an unsupported encryption format");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: copyToArrayBuffer(decodeBase64Url(encodedIv)) },
      await encryptionKey(env),
      copyToArrayBuffer(decodeBase64Url(encodedCiphertext)),
    );
    return decoder.decode(plaintext);
  } catch (error) {
    throw new Error("Cannot decrypt credential; verify the original NYAMAL_ENCRYPTION_KEY", {
      cause: error,
    });
  }
}
