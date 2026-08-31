export type EvidenceKind = "raw" | "html";

const CAPTURE_STYLE_ORIGINS =
  "https://chatgpt.com https://cdn.oaistatic.com https://cdn.openai.com";

export function decodedRawEvidenceBody(
  body: ReadableStream,
  key: string,
  metadata: Headers,
): ReadableStream {
  const encodedAsGzip = key.endsWith(".gz") ||
    metadata.get("content-encoding")?.toLowerCase().includes("gzip") === true;
  if (!encodedAsGzip) return body;
  metadata.delete("content-encoding");
  metadata.delete("content-length");
  return body.pipeThrough(new DecompressionStream("gzip"));
}

export function evidenceResponseHeaders(
  kind: EvidenceKind,
  snapshotId: string,
  metadata?: Headers,
): Headers {
  const headers = new Headers(metadata);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");

  if (kind === "raw") {
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set(
      "content-disposition",
      `inline; filename="${snapshotId}-raw.json"`,
    );
    return headers;
  }

  headers.set("content-type", "text/html; charset=utf-8");
  headers.set(
    "content-disposition",
    `inline; filename="${snapshotId}-evidence.html"`,
  );
  headers.set(
    "content-security-policy",
    [
      "sandbox allow-popups allow-popups-to-escape-sandbox",
      "default-src 'none'",
      "img-src https: data:",
      `style-src 'unsafe-inline' ${CAPTURE_STYLE_ORIGINS}`,
      `style-src-elem 'unsafe-inline' ${CAPTURE_STYLE_ORIGINS}`,
      "font-src https: data:",
      "script-src 'none'",
      "connect-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}
