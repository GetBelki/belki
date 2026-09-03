import {
  ENTITY_EXTRACTION_MODEL,
  ENTITY_RELATIONSHIP_PROMPT_VERSION,
  ENTITY_SPAN_PROMPT_VERSION,
  RELATIONSHIP_JSON_SCHEMA,
  SPAN_EXTRACTION_JSON_SCHEMA,
  applyRelationshipAssessments,
  chunkEntityText,
  entityModelSampling,
  entityModelSystemPrompt,
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
import { runAI } from "../lib/workers-ai";

interface EvaluationRequest {
  answer: string;
  queryText: string;
  languageCode: string;
  primaryDomain: string | null;
  trackedBrands: TrackedBrandRow[];
  providerEntities: ProviderEntityRow[];
  observedDomains: string[];
  evaluationModels?: {
    spanModel?: string;
    relationshipModel?: string;
  };
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

interface EvaluationUsage {
  spanInputTokens: number;
  spanOutputTokens: number;
  relationshipInputTokens: number;
  relationshipOutputTokens: number;
}

type EvaluationAi = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};

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
): Promise<{ entities: EvaluationEntity[]; usage: EvaluationUsage }> {
  const validated: ValidatedEntity[] = [];
  const usage: EvaluationUsage = {
    spanInputTokens: 0,
    spanOutputTokens: 0,
    relationshipInputTokens: 0,
    relationshipOutputTokens: 0,
  };
  const spanModel = input.evaluationModels?.spanModel ?? ENTITY_EXTRACTION_MODEL;
  const relationshipModel = input.evaluationModels?.relationshipModel
    ?? ENTITY_EXTRACTION_MODEL;
  const ai = env.AI as unknown as EvaluationAi;
  const knownBrands = input.trackedBrands.map((brand) => ({
    name: brand.name,
    kind: brand.kind,
    aliases: JSON.parse(brand.aliases_json) as string[],
    domains: JSON.parse(brand.domains_json) as string[],
  }));
  const evaluationId = crypto.randomUUID();
  for (const [chunkIndex, chunk] of chunkEntityText(input.answer).entries()) {
    const spanInput = {
      messages: [
        {
          role: "system" as const,
          content: entityModelSystemPrompt(spanModel, extractionSystemPrompt()),
        },
        {
          role: "user" as const,
          content: JSON.stringify({
            language_code: input.languageCode,
            answer_chunk: chunk,
          }),
        },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: SPAN_EXTRACTION_JSON_SCHEMA,
      },
      ...entityModelSampling(spanModel),
      seed: 731_991,
      max_tokens: 1_400,
    };
    const spanCall = await runAI({
      context: {
        feature: "entity_extraction_evaluation",
        operation: "span_extraction",
        model: spanModel,
        promptVersion: ENTITY_SPAN_PROMPT_VERSION,
        requestId: `${evaluationId}:chunk:${chunkIndex}:span`,
        retryAttempt: 1,
      },
      input: spanInput,
      invoke: () => ai.run(spanModel, spanInput),
      parse: (result) => parsedSpanAiResponse(aiEnvelope(result).response),
    });
    let chunkEntities = validateExtractedEntities(
      spanCall.value,
      chunk,
      {
        providerEntities: input.providerEntities,
        observedDomains: input.observedDomains,
        trackedBrands: input.trackedBrands,
      },
    );
    usage.spanInputTokens += spanCall.inputTokens;
    usage.spanOutputTokens += spanCall.outputTokens;
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
      const relationshipInput = {
        messages: [
          {
            role: "system" as const,
            content: entityModelSystemPrompt(
              relationshipModel,
              relationshipSystemPrompt(),
            ),
          },
          {
            role: "user" as const,
            content: JSON.stringify({
              tracked_query: input.queryText,
              owned_domain: input.primaryDomain,
              tracked_brands: knownBrands,
              candidates: unresolved,
            }),
          },
        ],
        response_format: {
          type: "json_schema" as const,
          json_schema: RELATIONSHIP_JSON_SCHEMA,
        },
        ...entityModelSampling(relationshipModel),
        seed: 731_991,
        max_tokens: 1_000,
      };
      const relationshipCall = await runAI({
        context: {
          feature: "entity_extraction_evaluation",
          operation: "relationship_classification",
          model: relationshipModel,
          promptVersion: ENTITY_RELATIONSHIP_PROMPT_VERSION,
          requestId: `${evaluationId}:chunk:${chunkIndex}:relationship`,
          retryAttempt: 1,
        },
        input: relationshipInput,
        invoke: () => ai.run(relationshipModel, relationshipInput),
        parse: (result) => parsedRelationshipAiResponse(aiEnvelope(result).response),
      });
      chunkEntities = applyRelationshipAssessments(
        chunkEntities,
        relationshipCall.value,
      );
      usage.relationshipInputTokens += relationshipCall.inputTokens;
      usage.relationshipOutputTokens += relationshipCall.outputTokens;
    }
    validated.push(...chunkEntities);
  }
  return { entities: combinedEntities(validated), usage };
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
