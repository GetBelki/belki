export type EvidenceKind = "raw" | "html";

const CAPTURE_ASSET_ORIGINS =
  "https://chatgpt.com https://cdn.oaistatic.com";

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
      `attachment; filename="${snapshotId}-raw.json"`,
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
      `style-src 'unsafe-inline' ${CAPTURE_ASSET_ORIGINS}`,
      `style-src-elem 'unsafe-inline' ${CAPTURE_ASSET_ORIGINS}`,
      `font-src data: ${CAPTURE_ASSET_ORIGINS}`,
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
