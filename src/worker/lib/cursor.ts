import { ApiError } from "./http";

type CursorPayload = {
  v: 1;
  kind: string;
  values: Record<string, string | number>;
};

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export function encodeCursor(
  kind: string,
  values: Record<string, string | number>,
): string {
  return encodeBase64Url(JSON.stringify({ v: 1, kind, values }));
}

export function decodeCursor<T extends Record<string, string | number>>(
  cursor: string | undefined,
  kind: string,
): T | null {
  if (!cursor) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(cursor)) as CursorPayload;
    if (
      payload.v !== 1 ||
      payload.kind !== kind ||
      !payload.values ||
      typeof payload.values !== "object" ||
      Array.isArray(payload.values)
    ) {
      throw new Error("Invalid cursor payload.");
    }
    return payload.values as T;
  } catch {
    throw new ApiError(
      400,
      "invalid_cursor",
      "The pagination cursor is invalid or belongs to another report.",
    );
  }
}
