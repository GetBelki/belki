const MAX_FAVICON_BYTES = 1024 * 1024;
const SUCCESS_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";
const FALLBACK_CACHE_CONTROL = "public, max-age=3600";

export type FaviconFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function validDomain(value: string | null | undefined): string | null {
  const domain = value?.trim().toLowerCase().replace(/\.$/u, "");
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  )
    ? domain
    : null;
}

function duckDuckGoUrl(domain: string): string {
  const encodedDomain = encodeURIComponent(domain);
  return `https://icons.duckduckgo.com/ip3/${encodedDomain}.ico`;
}

function faviconImUrl(domain: string): string {
  return `https://favicon.im/${encodeURIComponent(domain)}?larger=true&throw-error-on-404=true`;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The provider may already have closed an error response body.
  }
}

export async function fetchDomainFavicon(
  requestedDomain: string | null | undefined,
  fetcher: FaviconFetcher = fetch,
): Promise<Response> {
  const domain = validDomain(requestedDomain);
  if (!domain) {
    return new Response(null, {
      status: 400,
      headers: { "Cache-Control": FALLBACK_CACHE_CONTROL },
    });
  }

  try {
    const providerResponse = await fetcher(duckDuckGoUrl(domain), {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
    });
    const contentType = providerResponse.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const contentLength = Number(
      providerResponse.headers.get("content-length") ?? "0",
    );
    if (
      providerResponse.ok &&
      contentType?.startsWith("image/") &&
      (!Number.isFinite(contentLength) || contentLength <= MAX_FAVICON_BYTES)
    ) {
      return new Response(providerResponse.body, {
        status: 200,
        headers: {
          "Cache-Control": SUCCESS_CACHE_CONTROL,
          "Content-Type": contentType,
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    await discard(providerResponse);
  } catch {
    // A DuckDuckGo failure should advance to the next configured source.
  }

  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": FALLBACK_CACHE_CONTROL,
      Location: faviconImUrl(domain),
    },
  });
}
