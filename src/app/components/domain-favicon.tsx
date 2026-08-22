import { Globe2 } from "lucide-react";
import { useState } from "react";

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
  const [failedDomain, setFailedDomain] = useState<string | null>(null);
  const failed = failedDomain === normalizedDomain;

  return (
    <span className="domain-favicon" aria-hidden="true">
      {normalizedDomain && !failed ? (
        <img
          alt=""
          height={size}
          loading="lazy"
          onError={() => setFailedDomain(normalizedDomain)}
          referrerPolicy="no-referrer"
          src={`/api/v1/favicon?domain=${encodeURIComponent(normalizedDomain)}`}
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
