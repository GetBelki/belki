import { describe, expect, it } from "vitest";
import {
  applyRelationshipAssessments,
  chunkEntityText,
  estimatedEntityExtractionCost,
  parsedRelationshipAiResponse,
  parsedSpanAiResponse,
  validateExtractedEntities,
} from "../src/worker/automation/entity-extraction-core";

describe("entity extraction validation", () => {
  it("repairs fenced structured output and trailing commas safely", () => {
    expect(parsedSpanAiResponse(
      '```json\n{"entities":[{"surface":"Contoso","entity_type":"brand",}],}\n```',
    )).toEqual({ entities: [{ surface: "Contoso", entity_type: "brand" }] });
    expect(parsedRelationshipAiResponse(
      '{"assessments":[{"surface":"Contoso","relationship":"competitor","reason":"explicit_rival",}],}',
    )).toEqual({
      assessments: [{
        surface: "Contoso",
        relationship: "competitor",
        reason: "explicit_rival",
      }],
    });
    expect(parsedSpanAiResponse(
      '{"entities":[{"surface":"Contoso","entity_type":"brand"}{"surface":"Acme","entity_type":"company"}]}',
    )).toEqual({
      entities: [
        { surface: "Contoso", entity_type: "brand" },
        { surface: "Acme", entity_type: "company" },
      ],
    });
    expect(parsedSpanAiResponse(
      '{"entities":[{"surface":"Contoso","entity_type":"brand"},{"surface":"unfinished',
    )).toEqual({ entities: [{ surface: "Contoso", entity_type: "brand" }] });
  });

  it("discards malformed model items without failing the entire response", () => {
    expect(parsedSpanAiResponse({
      entities: [
        { surface: "X", entity_type: "brand" },
        { surface: "Canon", entity_type: "company" },
      ],
    })).toEqual({ entities: [{ surface: "Canon", entity_type: "company" }] });
    expect(parsedRelationshipAiResponse({
      assessments: [
        { surface: "X", relationship: "competitor", reason: "explicit_rival" },
        { surface: "Canon", relationship: "mentioned", reason: "incidental_mention" },
      ],
    })).toEqual({
      assessments: [{
        surface: "Canon",
        relationship: "mentioned",
        reason: "incidental_mention",
      }],
    });
  });

  it("rejects model entities whose surface text is absent", () => {
    expect(validateExtractedEntities({
      entities: [{
        surface: "Invented Corp",
        entity_type: "company",
      }],
    }, "Acme is compared with Contoso.")).toEqual([]);
  });

  it("stores the exact visible surface rather than model-normalized casing", () => {
    const [entity] = validateExtractedEntities({
      entities: [{ surface: "contoso", entity_type: "company" }],
    }, "Acme is compared with Contoso.");

    expect(entity?.surface).toBe("Contoso");
  });

  it("keeps exact entities and records deterministic corroboration", () => {
    const [entity] = validateExtractedEntities({
      entities: [{
        surface: "Contoso",
        entity_type: "company",
      }],
    }, "Acme is commonly compared with Contoso for enterprise reporting.", {
      providerEntities: [{ title: "Contoso", domains: ["contoso.com"] }],
      observedDomains: ["contoso.com"],
    });

    expect(entity).toMatchObject({
      normalizedName: "contoso",
      providerCorroborated: true,
      domainCorroborated: true,
      relationship: "unknown",
      evidence_tier: "moderate",
    });
    expect(entity?.evidence).toContain("Contoso");
  });

  it("uses tracked ownership as the authoritative relationship", () => {
    const [entity] = validateExtractedEntities({
      entities: [{
        surface: "ACME",
        entity_type: "company",
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
      relationship_reason: "owned_brand",
      evidence_tier: "strong",
    });
  });

  it("recovers exact provider entities even when the span model misses them", () => {
    const [entity] = validateExtractedEntities(
      { entities: [] },
      "The leading options are Salesforce and HubSpot.",
      {
        providerEntities: [{ title: "HubSpot", domains: ["hubspot.com"] }],
        observedDomains: ["hubspot.com"],
      },
    );

    expect(entity).toMatchObject({
      canonical_name: "HubSpot",
      providerCorroborated: true,
      domainCorroborated: true,
    });
    expect(entity?.sources).toEqual(
      expect.arrayContaining(["dataforseo_entity", "observed_domain"]),
    );
  });

  it("separates contextual competitor classification from span extraction", () => {
    const entities = validateExtractedEntities({
      entities: [{ surface: "Contoso", entity_type: "company" }],
    }, "Acme is commonly compared with Contoso for enterprise reporting.");
    const [classified] = applyRelationshipAssessments(entities, {
      assessments: [{
        surface: "Contoso",
        relationship: "competitor",
        reason: "explicit_comparison",
      }],
    });

    expect(classified).toMatchObject({
      relationship: "competitor",
      relationship_reason: "explicit_comparison",
      evidence_tier: "strong",
    });
  });

  it("keeps recommendation-set competitors reviewable without inventing certainty", () => {
    const entities = validateExtractedEntities({
      entities: [{ surface: "Contoso", entity_type: "brand" }],
    }, "Recommended tools include Contoso, Northwind, and Acme.");
    const [classified] = applyRelationshipAssessments(entities, {
      assessments: [{
        surface: "Contoso",
        relationship: "competitor",
        reason: "same_recommendation_set",
      }],
    });

    expect(classified).toMatchObject({
      relationship: "competitor",
      evidence_tier: "weak",
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
    expect(chunks.slice(1).some((chunk) => chunk.includes("Contoso"))).toBe(true);
  });

  it("calculates the stored list-price estimate from token usage", () => {
    expect(estimatedEntityExtractionCost(1_000_000, 1_000_000)).toBe(2.546);
  });
});
