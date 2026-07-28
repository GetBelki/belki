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
          src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizedDomain)}.ico`}
          width={size}
        />
      ) : (
        <Globe2 size={Math.max(12, size - 1)} />
      )}
    </span>
  );
}
