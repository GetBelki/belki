import { describe, expect, it } from "vitest";
import {
  chunkEntityText,
  estimatedEntityExtractionCost,
  validateExtractedEntities,
} from "../src/worker/automation/entity-extraction-core";

describe("entity extraction validation", () => {
  it("rejects model entities whose surface text is absent", () => {
    expect(validateExtractedEntities({
      entities: [{
        surface: "Invented Corp",
        canonical_name: "Invented Corp",
        entity_type: "company",
        relationship: "competitor",
        confidence: 0.99,
        domains: [],
      }],
    }, "Acme is compared with Contoso.")).toEqual([]);
  });

  it("keeps exact entities and records deterministic corroboration", () => {
    const [entity] = validateExtractedEntities({
      entities: [{
        surface: "Contoso",
        canonical_name: "Contoso",
        entity_type: "company",
        relationship: "competitor",
        confidence: 0.96,
        domains: ["https://www.contoso.com/pricing"],
      }],
    }, "Acme is commonly compared with Contoso for enterprise reporting.", {
      providerNames: ["Contoso"],
      observedDomains: ["contoso.com"],
    });

    expect(entity).toMatchObject({
      normalizedName: "contoso",
      providerCorroborated: true,
      domainCorroborated: true,
      relationship: "competitor",
    });
    expect(entity?.evidence).toContain("Contoso");
  });

  it("uses tracked ownership as the authoritative relationship", () => {
    const [entity] = validateExtractedEntities({
      entities: [{
        surface: "ACME",
        canonical_name: "ACME Inc.",
        entity_type: "company",
        relationship: "competitor",
        confidence: 0.9,
        domains: [],
      }],
    }, "ACME provides the service.", {
      trackedBrands: [{
        id: "brand-1",
        kind: "owned",
        name: "Acme",
        aliases_json: "[\"ACME Inc.\"]",
        domains_json: "[]",
      }],
    });

    expect(entity).toMatchObject({
      canonical_name: "Acme",
      normalizedName: "acme",
      relationship: "owned",
    });
  });
});

describe("entity extraction metering", () => {
  it("chunks long visible answers without retaining markdown URLs", () => {
    const chunks = chunkEntityText(
      `See [Acme](https://acme.example). ${"Contoso ".repeat(30)}`,
      80,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.join(" ")).not.toContain("https://");
  });

  it("calculates the stored list-price estimate from token usage", () => {
    expect(estimatedEntityExtractionCost(1_000_000, 1_000_000)).toBe(2.546);
  });
});
