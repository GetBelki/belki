import { Globe2 } from "lucide-react";
import { useState } from "react";

interface FailedFaviconAttempt {
  domain: string;
  count: number;
}

function normalizeDomain(domain: string | null | undefined): string | null {
  const normalized = domain
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    ?.replace(/^www\./, "");

  return normalized && /^[a-z0-9.-]+$/.test(normalized)
    ? normalized
    : null;
}

export function DomainFavicon({
  domain,
  size = 16,
}: {
  domain: string | null | undefined;
  size?: number;
}) {
  const normalizedDomain = normalizeDomain(domain);
  const [failedAttempt, setFailedAttempt] =
    useState<FailedFaviconAttempt | null>(null);
  const failedCount = failedAttempt?.domain === normalizedDomain
    ? failedAttempt.count
    : 0;
  const faviconSources = normalizedDomain
    ? [
        `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizedDomain)}.ico`,
        `https://favicon.im/${encodeURIComponent(normalizedDomain)}?larger=true&throw-error-on-404=true`,
      ]
    : [];
  const faviconSource = faviconSources[failedCount];

  return (
    <span className="domain-favicon" aria-hidden="true">
      {normalizedDomain && faviconSource ? (
        <img
          alt=""
          height={size}
          loading="lazy"
          onError={() => setFailedAttempt({
            domain: normalizedDomain,
            count: failedCount + 1,
          })}
          referrerPolicy="no-referrer"
          src={faviconSource}
          width={size}
        />
      ) : normalizedDomain ? (
        <span
          className="domain-favicon-monogram"
          style={{
            fontSize: Math.max(9, Math.round(size * 0.62)),
            height: size,
            width: size,
          }}
        >
          {normalizedDomain.charAt(0).toUpperCase()}
        </span>
      ) : (
        <Globe2 size={Math.max(12, size - 1)} />
      )}
    </span>
  );
}
