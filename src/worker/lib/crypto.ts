const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 600_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hashPassword(password: string): Promise<{
  algorithm: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  passwordHash: string;
}> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations: PASSWORD_ITERATIONS,
    },
    key,
    256,
  );
  return {
    algorithm: "pbkdf2-sha256",
    iterations: PASSWORD_ITERATIONS,
    salt: bytesToBase64Url(saltBytes),
    passwordHash: bytesToBase64Url(new Uint8Array(bits)),
  };
}

export async function verifyPassword(
  password: string,
  salt: string,
  iterations: number,
  expectedHash: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(salt),
      iterations,
    },
    key,
    256,
  );
  return await timingSafeEqual(
    new Uint8Array(bits),
    base64UrlToBytes(expectedHash),
  );
}

export function timingSafeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean | Promise<boolean> {
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function timingSafeTextEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  return await timingSafeEqual(base64UrlToBytes(leftHash), base64UrlToBytes(rightHash));
}

export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSignedJobTag(jobId: string, secret: string): Promise<string> {
  const signature = await hmac(jobId, secret);
  return `ait:${jobId}:${signature.slice(0, 24)}`;
}

export async function verifySignedJobTag(
  tag: string,
  secret: string,
): Promise<string | null> {
  const match = /^ait:([0-9a-f-]{36}):([A-Za-z0-9_-]{24})$/u.exec(tag);
  if (!match?.[1] || !match[2]) return null;
  const expected = await createSignedJobTag(match[1], secret);
  return (await timingSafeTextEqual(tag, expected)) ? match[1] : null;
}
