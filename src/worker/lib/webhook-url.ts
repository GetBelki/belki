import { ApiError } from "./http";

function isNonPublicIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function isNonPublicIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const value = host.replace(/^\[|\]$/gu, "").toLowerCase();
  return value === "::" ||
    value === "::1" ||
    value.startsWith("::") ||
    /^f[cd]/u.test(value) ||
    /^fe[89ab]/u.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:");
}

export function assertSafeWebhookUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const hostnameBlocked = host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    hostnameBlocked ||
    isNonPublicIpv4(host) ||
    isNonPublicIpv6(host)
  ) {
    throw new ApiError(422, "unsafe_webhook_url", "Only public HTTPS webhook targets are allowed.");
  }
  return url;
}
