import { describe, expect, it } from "vitest";
import {
  containsBrandMention,
  extractDomainsFromText,
  matchedBrandTerms,
  normalizeBrand,
  normalizeHostname,
  normalizeUrl,
} from "../src/worker/lib/domain";

describe("domain normalization", () => {
  it("canonicalizes URLs and removes tracking parameters", () => {
    expect(
      normalizeUrl("https://WWW.Example.co.uk/path/?utm_source=test&b=2&a=1#section"),
    ).toEqual({
      rawUrl: "https://WWW.Example.co.uk/path/?utm_source=test&b=2&a=1#section",
      canonicalUrl: "https://www.example.co.uk/path?a=1&b=2",
      hostname: "www.example.co.uk",
      registrableDomain: "example.co.uk",
    });
  });

  it("accepts plain hostnames and private suffixes", () => {
    expect(normalizeHostname("Docs.Example.com.")).toEqual({
      hostname: "docs.example.com",
      registrableDomain: "example.com",
    });
  });

  it("extracts and deduplicates seller domains from merchant labels", () => {
    expect(extractDomainsFromText("Amazon.de - Amazon.de-Seller")).toEqual([
      "amazon.de",
    ]);
    expect(extractDomainsFromText("dogslove.com + weitere")).toEqual([
      "dogslove.com",
    ]);
  });

  it("does not invent a domain when a merchant label has none", () => {
    expect(extractDomainsFromText("Pets Deli + weitere")).toEqual([]);
    expect(extractDomainsFromText(null)).toEqual([]);
  });

  it("normalizes brand matching without losing unicode", () => {
    expect(normalizeBrand("  Café   Déjà  ")).toBe("café déjà");
  });

  it("matches brand names independently of letter case and markdown formatting", () => {
    expect(
      containsBrandMention(
        "Wenn du das **PETS DELI** Saucen Menü meinst, ist es hochwertig.",
        "Pets Deli",
      ),
    ).toBe(true);
  });

  it("matches configured aliases and normalizes whitespace", () => {
    expect(
      matchedBrandTerms("I recommend Pets\nDeli for this query.", "Other", [
        "pets deli",
      ]),
    ).toEqual(["pets deli"]);
  });

  it("does not count a brand embedded inside another word", () => {
    expect(containsBrandMention("The carpet store is nearby.", "pet")).toBe(false);
  });

  it("does not count brand names found only in citation domains or URLs", () => {
    expect(
      matchedBrandTerms(
        "A regional provider may be suitable. [www.rebill.com](https://www.rebill.com/blog/rebill-vs-dlocal)",
        "Rebill",
        [],
      ),
    ).toEqual([]);
  });

  it("preserves genuine brand mentions that happen to be linked", () => {
    expect(
      matchedBrandTerms(
        "I recommend [Rebill](https://www.rebill.com) for subscription payments.",
        "Rebill",
        [],
      ),
    ).toEqual(["Rebill"]);
  });
});
