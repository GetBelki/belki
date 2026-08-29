const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_SIGNATURES = 16;

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyStandardWebhookSignature(
  payload: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const messageId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!messageId || !timestamp || !signatureHeader || messageId.includes(".")) return false;

  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > WEBHOOK_TOLERANCE_MS) {
    return false;
  }

  const encodedSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = base64Bytes(encodedSecret);
  if (!keyBytes || keyBytes.byteLength < 24 || keyBytes.byteLength > 64) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${messageId}.${timestamp}.${payload}`),
  ));
  const signatures = signatureHeader.trim().split(/\s+/u).slice(0, MAX_SIGNATURES);
  for (const versionedSignature of signatures) {
    const comma = versionedSignature.indexOf(",");
    if (comma < 0 || versionedSignature.slice(0, comma) !== "v1") continue;
    const actual = base64Bytes(versionedSignature.slice(comma + 1));
    if (actual && constantTimeEqual(expected, actual)) return true;
  }
  return false;
}
