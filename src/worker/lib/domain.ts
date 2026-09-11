import { getDomain, parse } from "tldts";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
  "ref_src",
  "source",
]);

export interface NormalizedUrl {
  rawUrl: string | null;
  canonicalUrl: string | null;
  hostname: string | null;
  registrableDomain: string | null;
}

export function normalizeHostname(value: string | null | undefined): {
  hostname: string | null;
  registrableDomain: string | null;
} {
  if (!value) return { hostname: null, registrableDomain: null };
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!hostname) return { hostname: null, registrableDomain: null };
  return {
    hostname,
    registrableDomain: getDomain(hostname, { allowPrivateDomains: true }) ?? hostname,
  };
}

export function normalizeUrl(value: string | null | undefined): NormalizedUrl {
  if (!value) {
    return { rawUrl: null, canonicalUrl: null, hostname: null, registrableDomain: null };
  }
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    const normalized = normalizeHostname(url.hostname);
    return {
      rawUrl: value,
      canonicalUrl: url.toString(),
      hostname: normalized.hostname,
      registrableDomain: normalized.registrableDomain,
    };
  } catch {
    const normalized = normalizeHostname(value);
    return {
      rawUrl: value,
      canonicalUrl: null,
      hostname: normalized.hostname,
      registrableDomain: normalized.registrableDomain,
    };
  }
}

export function extractDomainsFromText(value: string | null | undefined): string[] {
  if (!value) return [];

  const domains = new Set<string>();
  const candidates = value.matchAll(
    /(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/giu,
  );

  for (const candidate of candidates) {
    const hostname = candidate[0]
      .replace(/^https?:\/\//iu, "")
      .replace(/^www\./iu, "")
      .toLowerCase();
    const parsed = parse(hostname, { allowPrivateDomains: true });
    if (parsed.domain && (parsed.isIcann || parsed.isPrivate)) {
      domains.add(parsed.domain);
    }
  }

  return [...domains];
}

export function normalizeBrand(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}

const MARKDOWN_ENTITY_WRAPPERS = ["***", "___", "**", "__", "~~", "*", "_"] as const;

export function stripMarkdownEntityDecoration(value: string): string {
  let surface = value.trim();
  let changed = true;

  while (changed) {
    changed = false;
    for (const wrapper of MARKDOWN_ENTITY_WRAPPERS) {
      if (
        surface.length > wrapper.length * 2 &&
        surface.startsWith(wrapper) &&
        surface.endsWith(wrapper)
      ) {
        const unwrapped = surface.slice(wrapper.length, -wrapper.length).trim();
        if (unwrapped) {
          surface = unwrapped;
          changed = true;
          break;
        }
      }
    }
  }

  return surface;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface AmbiguousBrandRule {
  canonicalSurface: string;
  precedingWords: ReadonlySet<string>;
}

const AMBIGUOUS_BRAND_RULES = new Map<string, AmbiguousBrandRule>([
  ["flow", {
    canonicalSurface: "Flow",
    precedingWords: new Set([
      "approval",
      "authorization",
      "billing",
      "cash",
      "checkout",
      "customer",
      "data",
      "fund",
      "funds",
      "information",
      "money",
      "operational",
      "payment",
      "payments",
      "process",
      "redirect",
      "revenue",
      "subscription",
      "traffic",
      "transaction",
      "user",
      "work",
      "workflow",
    ]),
  }],
]);

export interface BrandMentionSpan {
  end: number;
  start: number;
  surface: string;
}

function hasAmbiguousCommonWordContext(
  text: string,
  start: number,
  rule: AmbiguousBrandRule,
): boolean {
  const prefix = text.slice(Math.max(0, start - 64), start);
  const word = /([\p{L}\p{N}]+)[\s*_~]+$/u.exec(prefix)?.[1];
  return Boolean(word && rule.precedingWords.has(word.toLocaleLowerCase("en-US")));
}

export function brandMentionSpansInText(
  visibleText: string,
  brandName: string,
): BrandMentionSpan[] {
  const candidate = brandName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!candidate) return [];
  const pattern = escapeRegExp(candidate).replace(/\s+/gu, "\\s+");
  const ambiguousRule = AMBIGUOUS_BRAND_RULES.get(
    candidate.toLocaleLowerCase("en-US"),
  );
  const expression = new RegExp(
    `(^|[^\\p{L}\\p{N}\\p{Dash_Punctuation}])(${pattern})(?=$|[^\\p{L}\\p{N}\\p{Dash_Punctuation}])`,
    ambiguousRule ? "gu" : "giu",
  );
  const matches: BrandMentionSpan[] = [];
  for (let match = expression.exec(visibleText); match; match = expression.exec(visibleText)) {
    const prefixLength = match[1]?.length ?? 0;
    const surface = match[2] ?? "";
    const start = (match.index ?? 0) + prefixLength;
    if (
      ambiguousRule &&
      (surface !== ambiguousRule.canonicalSurface ||
        hasAmbiguousCommonWordContext(visibleText, start, ambiguousRule))
    ) {
      continue;
    }
    matches.push({ start, end: start + surface.length, surface });
  }
  return matches;
}

export function brandMentionSpans(
  text: string,
  brandName: string,
): BrandMentionSpan[] {
  return brandMentionSpansInText(
    brandMentionText(text).normalize("NFKC"),
    brandName,
  );
}

function isDomainLabel(value: string): boolean {
  return /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/\S*)?$/iu
    .test(value.trim());
}

export function brandMentionText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/(!?)\[([^\]]*)\]\((?:\\.|[^)])*\)/gu, (_match, image, label: string) => {
      if (image || isDomainLabel(label)) return " ";
      return ` ${label} `;
    })
    .replace(/<https?:\/\/[^>]+>/giu, " ")
    .replace(/https?:\/\/[^\s<>{}]+/giu, " ")
    .replace(
      /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>{}]*)?/giu,
      " ",
    );
}

export function containsBrandMention(text: string, brandName: string): boolean {
  // A dash joins a compound word; it must not turn `cash-flow` into a mention
  // of the tracked brand `Flow`. Ambiguous common-word brands additionally
  // require brand casing and reject their ordinary phrase contexts.
  return brandMentionSpans(text, brandName).length > 0;
}

export function matchedBrandTerms(
  text: string,
  name: string,
  aliases: string[],
): string[] {
  return [name, ...aliases].filter(
    (term, index, terms) =>
      term.trim() &&
      terms.findIndex((candidate) => normalizeBrand(candidate) === normalizeBrand(term)) ===
        index &&
      containsBrandMention(text, term),
  );
}
