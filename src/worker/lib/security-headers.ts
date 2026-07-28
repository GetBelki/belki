const DEFAULT_SECURITY_HEADERS = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-frame-options", "DENY"],
  [
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
  ],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
] as const;

export function missingDefaultSecurityHeaders(
  responseHeaders: Headers,
): Array<readonly [string, string]> {
  return DEFAULT_SECURITY_HEADERS.filter(
    ([name]) => !responseHeaders.has(name),
  );
}
