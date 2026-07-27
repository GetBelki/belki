import { describe, expect, it } from "vitest";
import { normalizeBrand, normalizeHostname, normalizeUrl } from "../src/worker/lib/domain";

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

  it("normalizes brand matching without losing unicode", () => {
    expect(normalizeBrand("  Café   Déjà  ")).toBe("café déjà");
  });
});
