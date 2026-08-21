import {
  ENTITY_EXTRACTION_MODEL,
  RELATIONSHIP_JSON_SCHEMA,
  SPAN_EXTRACTION_JSON_SCHEMA,
  applyRelationshipAssessments,
  chunkEntityText,
  extractionSystemPrompt,
  parsedRelationshipAiResponse,
  parsedSpanAiResponse,
  relationshipSystemPrompt,
  validateExtractedEntities,
  type ExtractedEntity,
  type ProviderEntityRow,
  type TrackedBrandRow,
  type ValidatedEntity,
} from "./entity-extraction-core";

interface EvaluationRequest {
  answer: string;
  queryText: string;
  languageCode: string;
  primaryDomain: string | null;
  trackedBrands: TrackedBrandRow[];
  providerEntities: ProviderEntityRow[];
  observedDomains: string[];
}

interface AiEnvelope {
  response?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface EvaluationEntity extends ExtractedEntity {
  providerCorroborated: boolean;
  domainCorroborated: boolean;
  evidence: string;
}

function aiEnvelope(result: unknown): AiEnvelope {
  return typeof result === "object" && result !== null
    ? result
    : { response: result };
}

function combinedEntities(entities: ValidatedEntity[]): EvaluationEntity[] {
  const combined = new Map<string, EvaluationEntity>();
  const relationshipRank = { unknown: 0, mentioned: 1, competitor: 2, owned: 3 };
  const evidenceRank = { weak: 0, moderate: 1, strong: 2 };
  for (const entity of entities) {
    const existing = combined.get(entity.normalizedName);
    const current: EvaluationEntity = {
      surface: entity.surface,
      canonical_name: entity.canonical_name,
      entity_type: entity.entity_type,
      relationship: entity.relationship,
      relationship_reason: entity.relationship_reason,
      evidence_tier: entity.evidence_tier,
      domains: entity.domains,
      sources: entity.sources,
      providerCorroborated: entity.providerCorroborated,
      domainCorroborated: entity.domainCorroborated,
      evidence: entity.evidence,
    };
    if (!existing) {
      combined.set(entity.normalizedName, current);
      continue;
    }
    existing.domains = [...new Set([...existing.domains, ...current.domains])];
    existing.sources = [...new Set([...existing.sources, ...current.sources])];
    existing.providerCorroborated ||= current.providerCorroborated;
    existing.domainCorroborated ||= current.domainCorroborated;
    if (relationshipRank[current.relationship] > relationshipRank[existing.relationship]) {
      existing.relationship = current.relationship;
      existing.relationship_reason = current.relationship_reason;
    }
    if (evidenceRank[current.evidence_tier] > evidenceRank[existing.evidence_tier]) {
      existing.evidence_tier = current.evidence_tier;
    }
  }
  return [...combined.values()];
}

async function extract(
  env: Pick<Env, "AI">,
  input: EvaluationRequest,
): Promise<{ entities: EvaluationEntity[]; inputTokens: number; outputTokens: number }> {
  const validated: ValidatedEntity[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const knownBrands = input.trackedBrands.map((brand) => ({
    name: brand.name,
    kind: brand.kind,
    aliases: JSON.parse(brand.aliases_json) as string[],
    domains: JSON.parse(brand.domains_json) as string[],
  }));
  for (const chunk of chunkEntityText(input.answer)) {
    const spanRaw = aiEnvelope(await env.AI.run(ENTITY_EXTRACTION_MODEL, {
      messages: [
        { role: "system", content: extractionSystemPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            language_code: input.languageCode,
            answer_chunk: chunk,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: SPAN_EXTRACTION_JSON_SCHEMA,
      },
      temperature: 0,
      seed: 731_991,
      max_tokens: 1_400,
    }));
    let chunkEntities = validateExtractedEntities(
      parsedSpanAiResponse(spanRaw.response),
      chunk,
      {
        providerEntities: input.providerEntities,
        observedDomains: input.observedDomains,
        trackedBrands: input.trackedBrands,
      },
    );
    inputTokens += Number(spanRaw.usage?.prompt_tokens ?? 0);
    outputTokens += Number(spanRaw.usage?.completion_tokens ?? 0);
    const unresolved = chunkEntities
      .filter((entity) =>
        !entity.trackedBrand &&
        ["brand", "company", "organization"].includes(entity.entity_type),
      )
      .map((entity) => ({
        surface: entity.surface,
        entity_type: entity.entity_type,
        evidence: entity.evidence,
        provider_corroborated: entity.providerCorroborated,
        domain_corroborated: entity.domainCorroborated,
      }));
    if (unresolved.length) {
      const relationshipRaw = aiEnvelope(await env.AI.run(ENTITY_EXTRACTION_MODEL, {
        messages: [
          { role: "system", content: relationshipSystemPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              tracked_query: input.queryText,
              owned_domain: input.primaryDomain,
              tracked_brands: knownBrands,
              candidates: unresolved,
            }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: RELATIONSHIP_JSON_SCHEMA,
        },
        temperature: 0,
        seed: 731_991,
        max_tokens: 1_000,
      }));
      chunkEntities = applyRelationshipAssessments(
        chunkEntities,
        parsedRelationshipAiResponse(relationshipRaw.response),
      );
      inputTokens += Number(relationshipRaw.usage?.prompt_tokens ?? 0);
      outputTokens += Number(relationshipRaw.usage?.completion_tokens ?? 0);
    }
    validated.push(...chunkEntities);
  }
  return { entities: combinedEntities(validated), inputTokens, outputTokens };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method !== "POST" || url.pathname !== "/extract") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const input = await request.json<EvaluationRequest>();
      const result = await extract(env, input);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Pick<Env, "AI">>;
