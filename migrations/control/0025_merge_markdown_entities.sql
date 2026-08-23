-- Merge entities that were extracted with a full-name Markdown bold wrapper
-- into an existing undecorated entity in the same project.

CREATE TABLE migration_0025_markdown_entity_map (
  source_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_tracked_brand_id TEXT
);

INSERT INTO migration_0025_markdown_entity_map (
  source_id, target_id, project_id, source_tracked_brand_id
)
SELECT source.id, target.id, source.project_id, source.tracked_brand_id
FROM project_entities source
JOIN project_entities target
  ON target.project_id = source.project_id
 AND target.id != source.id
 AND target.status != 'merged'
 AND target.normalized_name = lower(trim(
   substr(source.canonical_name, 3, length(source.canonical_name) - 4)
 ))
WHERE source.status != 'merged'
  AND length(source.canonical_name) > 4
  AND (
    (substr(source.canonical_name, 1, 2) = '**'
      AND substr(source.canonical_name, -2) = '**')
    OR (substr(source.canonical_name, 1, 2) = '__'
      AND substr(source.canonical_name, -2) = '__')
  );

INSERT INTO analytics_read_model_projects (
  project_id, status, schema_version, updated_at
)
SELECT DISTINCT project_id, 'pending', 9, datetime('now')
FROM migration_0025_markdown_entity_map
WHERE source_tracked_brand_id IS NOT NULL
ON CONFLICT(project_id) DO UPDATE SET
  status = 'pending',
  schema_version = MAX(
    analytics_read_model_projects.schema_version,
    excluded.schema_version
  ),
  backfill_shard_id = NULL,
  backfill_captured_at = NULL,
  backfill_snapshot_id = NULL,
  error_message = NULL,
  updated_at = excluded.updated_at;

UPDATE projects
SET brand_metrics_revision = brand_metrics_revision + 1,
  updated_at = datetime('now')
WHERE id IN (
  SELECT project_id
  FROM migration_0025_markdown_entity_map
  WHERE source_tracked_brand_id IS NOT NULL
);

UPDATE project_entities AS target
SET first_seen_at = MIN(
    target.first_seen_at,
    COALESCE((
      SELECT MIN(source.first_seen_at)
      FROM migration_0025_markdown_entity_map entity_map
      JOIN project_entities source ON source.id = entity_map.source_id
      WHERE entity_map.target_id = target.id
    ), target.first_seen_at)
  ),
  last_seen_at = MAX(
    target.last_seen_at,
    COALESCE((
      SELECT MAX(source.last_seen_at)
      FROM migration_0025_markdown_entity_map entity_map
      JOIN project_entities source ON source.id = entity_map.source_id
      WHERE entity_map.target_id = target.id
    ), target.last_seen_at)
  ),
  provider_corroborated = MAX(
    target.provider_corroborated,
    COALESCE((
      SELECT MAX(source.provider_corroborated)
      FROM migration_0025_markdown_entity_map entity_map
      JOIN project_entities source ON source.id = entity_map.source_id
      WHERE entity_map.target_id = target.id
    ), 0)
  ),
  domain_corroborated = MAX(
    target.domain_corroborated,
    COALESCE((
      SELECT MAX(source.domain_corroborated)
      FROM migration_0025_markdown_entity_map entity_map
      JOIN project_entities source ON source.id = entity_map.source_id
      WHERE entity_map.target_id = target.id
    ), 0)
  ),
  aliases_json = CASE
    WHEN target.aliases_json = '[]' THEN COALESCE((
      SELECT source.aliases_json
      FROM migration_0025_markdown_entity_map entity_map
      JOIN project_entities source ON source.id = entity_map.source_id
      WHERE entity_map.target_id = target.id AND source.aliases_json != '[]'
      LIMIT 1
    ), target.aliases_json)
    ELSE target.aliases_json
  END,
  domains_json = CASE
    WHEN target.domains_json = '[]' THEN COALESCE((
      SELECT source.domains_json
      FROM migration_0025_markdown_entity_map entity_map
      JOIN project_entities source ON source.id = entity_map.source_id
      WHERE entity_map.target_id = target.id AND source.domains_json != '[]'
      LIMIT 1
    ), target.domains_json)
    ELSE target.domains_json
  END,
  updated_at = datetime('now')
WHERE target.id IN (
  SELECT target_id FROM migration_0025_markdown_entity_map
);

-- Preserve the stronger values when both identities were recorded for a snapshot.
UPDATE entity_mentions AS target_mention
SET occurrence_count = MAX(
    target_mention.occurrence_count,
    COALESCE((
      SELECT MAX(source_mention.occurrence_count)
      FROM migration_0025_markdown_entity_map entity_map
      JOIN entity_mentions source_mention
        ON source_mention.entity_id = entity_map.source_id
      WHERE entity_map.target_id = target_mention.entity_id
        AND source_mention.snapshot_id = target_mention.snapshot_id
        AND source_mention.extractor_version = target_mention.extractor_version
    ), target_mention.occurrence_count)
  ),
  confidence = MAX(
    target_mention.confidence,
    COALESCE((
      SELECT MAX(source_mention.confidence)
      FROM migration_0025_markdown_entity_map entity_map
      JOIN entity_mentions source_mention
        ON source_mention.entity_id = entity_map.source_id
      WHERE entity_map.target_id = target_mention.entity_id
        AND source_mention.snapshot_id = target_mention.snapshot_id
        AND source_mention.extractor_version = target_mention.extractor_version
    ), target_mention.confidence)
  ),
  evidence_tier = CASE
    WHEN target_mention.evidence_tier = 'strong' OR EXISTS (
      SELECT 1
      FROM migration_0025_markdown_entity_map entity_map
      JOIN entity_mentions source_mention
        ON source_mention.entity_id = entity_map.source_id
      WHERE entity_map.target_id = target_mention.entity_id
        AND source_mention.snapshot_id = target_mention.snapshot_id
        AND source_mention.extractor_version = target_mention.extractor_version
        AND source_mention.evidence_tier = 'strong'
    ) THEN 'strong'
    WHEN target_mention.evidence_tier = 'moderate' OR EXISTS (
      SELECT 1
      FROM migration_0025_markdown_entity_map entity_map
      JOIN entity_mentions source_mention
        ON source_mention.entity_id = entity_map.source_id
      WHERE entity_map.target_id = target_mention.entity_id
        AND source_mention.snapshot_id = target_mention.snapshot_id
        AND source_mention.extractor_version = target_mention.extractor_version
        AND source_mention.evidence_tier = 'moderate'
    ) THEN 'moderate'
    ELSE 'weak'
  END
WHERE EXISTS (
  SELECT 1
  FROM migration_0025_markdown_entity_map entity_map
  JOIN entity_mentions source_mention
    ON source_mention.entity_id = entity_map.source_id
  WHERE entity_map.target_id = target_mention.entity_id
    AND source_mention.snapshot_id = target_mention.snapshot_id
    AND source_mention.extractor_version = target_mention.extractor_version
);

DELETE FROM entity_mentions AS source_mention
WHERE EXISTS (
  SELECT 1
  FROM migration_0025_markdown_entity_map entity_map
  JOIN entity_mentions target_mention
    ON target_mention.entity_id = entity_map.target_id
   AND target_mention.snapshot_id = source_mention.snapshot_id
   AND target_mention.extractor_version = source_mention.extractor_version
  WHERE entity_map.source_id = source_mention.entity_id
);

UPDATE entity_mentions
SET entity_id = (
  SELECT target_id
  FROM migration_0025_markdown_entity_map entity_map
  WHERE entity_map.source_id = entity_mentions.entity_id
)
WHERE entity_id IN (
  SELECT source_id FROM migration_0025_markdown_entity_map
);

DELETE FROM tracked_brands
WHERE id IN (
  SELECT source_tracked_brand_id
  FROM migration_0025_markdown_entity_map
  WHERE source_tracked_brand_id IS NOT NULL
);

UPDATE project_entities AS source
SET status = 'merged',
  tracked_brand_id = NULL,
  merged_into_id = (
    SELECT target_id
    FROM migration_0025_markdown_entity_map entity_map
    WHERE entity_map.source_id = source.id
  ),
  snapshot_count = 0,
  prompt_count = 0,
  competitor_snapshot_count = 0,
  competitor_prompt_count = 0,
  updated_at = datetime('now')
WHERE source.id IN (
  SELECT source_id FROM migration_0025_markdown_entity_map
);

UPDATE project_entities AS target
SET snapshot_count = (
    SELECT COUNT(DISTINCT mention.snapshot_id)
    FROM entity_mentions mention
    JOIN projects project ON project.id = target.project_id
    WHERE mention.entity_id = target.id
      AND mention.extractor_version = project.active_entity_extractor_version
  ),
  prompt_count = (
    SELECT COUNT(DISTINCT mention.tracked_query_id)
    FROM entity_mentions mention
    JOIN projects project ON project.id = target.project_id
    WHERE mention.entity_id = target.id
      AND mention.extractor_version = project.active_entity_extractor_version
  ),
  competitor_snapshot_count = (
    SELECT COUNT(DISTINCT mention.snapshot_id)
    FROM entity_mentions mention
    JOIN projects project ON project.id = target.project_id
    WHERE mention.entity_id = target.id
      AND mention.relationship = 'competitor'
      AND mention.extractor_version = project.active_entity_extractor_version
  ),
  competitor_prompt_count = (
    SELECT COUNT(DISTINCT mention.tracked_query_id)
    FROM entity_mentions mention
    JOIN projects project ON project.id = target.project_id
    WHERE mention.entity_id = target.id
      AND mention.relationship = 'competitor'
      AND mention.extractor_version = project.active_entity_extractor_version
  ),
  updated_at = datetime('now')
WHERE target.id IN (
  SELECT target_id FROM migration_0025_markdown_entity_map
);

DROP TABLE migration_0025_markdown_entity_map;
