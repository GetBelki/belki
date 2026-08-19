import { describe, expect, it } from "vitest";
import { buildProductCompetition } from "../src/worker/routes/analytics";

function occurrence({
  id,
  snapshot,
  productId,
  ordinal,
  title,
}: {
  id: string;
  snapshot: string;
  productId: string;
  ordinal: number;
  title: string;
}) {
  return {
    id,
    snapshot_id: snapshot,
    tracked_query_id: "query-1",
    keyword: "best protein bar",
    location_code: 2276,
    language_code: "en",
    ordinal,
    rank_absolute: null,
    provider_product_id: productId,
    merchants: "Example shop",
    title,
    price: 3.5,
    currency: "EUR",
    tag: null,
    raw_url: null,
    canonical_url: null,
    registrable_domain: "example.com",
    rating_value: 4.5,
    rating_votes_count: 100,
    rating_max: 5,
    images_json: "[]",
    product_ids_json: "[]",
    captured_at: `2026-08-${id.padStart(2, "0")}T09:00:00.000Z`,
  };
}

describe("product competition reporting", () => {
  it("uses only shared captures and deduplicates positions by response", () => {
    const target = [
      occurrence({ id: "1", snapshot: "s1", productId: "target", ordinal: 1, title: "Target" }),
      occurrence({ id: "2", snapshot: "s1", productId: "target", ordinal: 2, title: "Target" }),
      occurrence({ id: "3", snapshot: "s2", productId: "target", ordinal: 0, title: "Target" }),
    ];
    const competition = buildProductCompetition("id:target", target, [
      ...target,
      occurrence({ id: "4", snapshot: "s1", productId: "peer", ordinal: 0, title: "Peer" }),
      occurrence({ id: "5", snapshot: "s2", productId: "peer", ordinal: 2, title: "Peer" }),
      occurrence({ id: "6", snapshot: "unrelated", productId: "other", ordinal: 0, title: "Unrelated" }),
    ]);

    expect(competition.current).toMatchObject({ count: 2, median: 1.5 });
    expect(competition.coFeatured).toHaveLength(1);
    expect(competition.coFeatured[0]).toMatchObject({
      coFeaturedCaptures: 2,
      coFeatureRate: 100,
      winningCaptures: 1,
      winRate: 50,
      averagePosition: 2,
    });
    expect(competition.coFeatured[0]?.product.title).toBe("Peer");
  });
});
