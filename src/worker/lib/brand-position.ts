import { brandMentionSpansInText, brandMentionText } from "./domain";

export interface BrandPositionInput {
  id: string;
  kind: "owned" | "competitor";
  name: string;
  aliases: string[];
}

export interface RankedBrandMention {
  brandId: string;
  kind: "owned" | "competitor";
  position: number;
}

interface SurfaceMatch {
  brand: BrandPositionInput;
  start: number;
  end: number;
}

interface CompiledBrandPositionInput {
  brand: BrandPositionInput;
  terms: string[];
}

function compileBrand(
  brand: BrandPositionInput,
): CompiledBrandPositionInput {
  const terms = [brand.name, ...brand.aliases]
    .map((term) => term.normalize("NFKC").trim())
    .filter(Boolean)
    .filter(
      (term, index, terms) =>
        terms.findIndex(
          (candidate) =>
            candidate.toLocaleLowerCase("en-US") ===
            term.toLocaleLowerCase("en-US"),
        ) === index,
    );
  return { brand, terms };
}

function matchesForBrand(
  text: string,
  compiled: CompiledBrandPositionInput,
): SurfaceMatch[] {
  const matches = new Map<string, SurfaceMatch>();
  for (const term of compiled.terms) {
    for (const { start, end } of brandMentionSpansInText(text, term)) {
      matches.set(`${start}:${end}`, { brand: compiled.brand, start, end });
    }
  }
  return [...matches.values()];
}

function overlaps(left: SurfaceMatch, right: SurfaceMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * Ranks distinct tracked brands by their first unambiguous mention in the
 * visible answer text. Longer overlapping names win ("Acme Labs" over
 * "Acme"), while an identical surface assigned to multiple brands is ignored.
 */
function rankCompiledBrandFirstMentions(
  answer: string,
  brands: CompiledBrandPositionInput[],
): RankedBrandMention[] {
  const text = brandMentionText(answer).normalize("NFKC");
  const candidates = brands.flatMap((brand) => matchesForBrand(text, brand));
  const identicalSurfaceCounts = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = `${candidate.start}:${candidate.end}`;
    const brandIds = identicalSurfaceCounts.get(key) ?? new Set<string>();
    brandIds.add(candidate.brand.id);
    identicalSurfaceCounts.set(key, brandIds);
  }
  const selected: SurfaceMatch[] = [];
  for (const candidate of candidates
    .filter(
      (match) =>
        identicalSurfaceCounts.get(`${match.start}:${match.end}`)?.size === 1,
    )
    .sort(
      (left, right) =>
        left.start - right.start ||
        (right.end - right.start) - (left.end - left.start) ||
        left.brand.name.localeCompare(right.brand.name) ||
        left.brand.id.localeCompare(right.brand.id),
    )) {
    if (selected.some((match) => overlaps(match, candidate))) continue;
    selected.push(candidate);
  }

  const earliestByBrand = new Map<string, SurfaceMatch>();
  for (const match of selected.sort((left, right) => left.start - right.start)) {
    if (!earliestByBrand.has(match.brand.id)) {
      earliestByBrand.set(match.brand.id, match);
    }
  }
  return [...earliestByBrand.values()]
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.brand.name.localeCompare(right.brand.name) ||
        left.brand.id.localeCompare(right.brand.id),
    )
    .map((match, index) => ({
      brandId: match.brand.id,
      kind: match.brand.kind,
      position: index + 1,
    }));
}

export function createBrandFirstMentionRanker(
  brands: BrandPositionInput[],
): (answer: string) => RankedBrandMention[] {
  const compiled = brands.map(compileBrand);
  return (answer) => rankCompiledBrandFirstMentions(answer, compiled);
}

export function rankBrandFirstMentions(
  answer: string,
  brands: BrandPositionInput[],
): RankedBrandMention[] {
  return createBrandFirstMentionRanker(brands)(answer);
}
