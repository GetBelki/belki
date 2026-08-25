import { describe, expect, it } from "vitest";
import {
  createBrandFirstMentionRanker,
  rankBrandFirstMentions,
} from "../src/worker/lib/brand-position";

const brands = [
  { id: "owned", kind: "owned" as const, name: "Acme", aliases: ["Acme Inc"] },
  { id: "rival", kind: "competitor" as const, name: "Rival", aliases: [] },
  { id: "other", kind: "competitor" as const, name: "Other Co", aliases: [] },
];

describe("brand first-mention position", () => {
  it("ranks distinct brands by their earliest visible mention", () => {
    expect(rankBrandFirstMentions(
      "Rival leads this list. Acme appears next. Rival is mentioned again.",
      brands,
    )).toEqual([
      { brandId: "rival", kind: "competitor", position: 1 },
      { brandId: "owned", kind: "owned", position: 2 },
    ]);
  });

  it("uses aliases and ignores brand-looking URLs", () => {
    expect(rankBrandFirstMentions(
      "See https://rival.example first. **Acme Inc** is recommended before Rival.",
      brands,
    )).toEqual([
      { brandId: "owned", kind: "owned", position: 1 },
      { brandId: "rival", kind: "competitor", position: 2 },
    ]);
  });

  it("prefers the longer overlapping brand surface", () => {
    expect(rankBrandFirstMentions("Acme Labs is listed before Acme.", [
      ...brands.slice(0, 1),
      {
        id: "labs",
        kind: "competitor" as const,
        name: "Acme Labs",
        aliases: [],
      },
    ])).toEqual([
      { brandId: "labs", kind: "competitor", position: 1 },
      { brandId: "owned", kind: "owned", position: 2 },
    ]);
  });

  it("drops an identical surface assigned to multiple brands", () => {
    expect(rankBrandFirstMentions("Shared appears here.", [
      { id: "one", kind: "owned", name: "Shared", aliases: [] },
      { id: "two", kind: "competitor", name: "Shared", aliases: [] },
    ])).toEqual([]);
  });

  it("returns no invented positions when no tracked brand appears", () => {
    expect(rankBrandFirstMentions("No tracked company appears.", brands)).toEqual([]);
  });

  it("reuses compiled matchers across a backfill batch", () => {
    const rank = createBrandFirstMentionRanker(brands);

    expect(rank("Rival appears before Acme.")).toEqual([
      { brandId: "rival", kind: "competitor", position: 1 },
      { brandId: "owned", kind: "owned", position: 2 },
    ]);
    expect(rank("Acme appears without another tracked brand.")).toEqual([
      { brandId: "owned", kind: "owned", position: 1 },
    ]);
  });
});
