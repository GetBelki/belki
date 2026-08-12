PRAGMA foreign_keys = ON;

ALTER TABLE projects
  ADD COLUMN product_enrichment_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects
  ADD COLUMN entity_extraction_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE projects
  ADD COLUMN entity_auto_track_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects
  ADD COLUMN product_enrichment_warning_usd REAL NOT NULL DEFAULT 10;

ALTER TABLE projects
  ADD COLUMN entity_extraction_warning_usd REAL NOT NULL DEFAULT 5;

-- Preserve the behavior of existing projects while new projects use safer defaults.
UPDATE projects
SET product_enrichment_enabled = COALESCE((
      SELECT workspace.product_enrichment_enabled
      FROM workspaces workspace
      WHERE workspace.id = projects.workspace_id
    ), 0),
    entity_extraction_enabled = COALESCE((
      SELECT workspace.entity_extraction_enabled
      FROM workspaces workspace
      WHERE workspace.id = projects.workspace_id
    ), 1),
    entity_auto_track_enabled = COALESCE((
      SELECT workspace.entity_auto_track_enabled
      FROM workspaces workspace
      WHERE workspace.id = projects.workspace_id
    ), 0),
    product_enrichment_warning_usd = COALESCE((
      SELECT workspace.product_enrichment_warning_usd
      FROM workspaces workspace
      WHERE workspace.id = projects.workspace_id
    ), 10),
    entity_extraction_warning_usd = COALESCE((
      SELECT workspace.entity_extraction_warning_usd
      FROM workspaces workspace
      WHERE workspace.id = projects.workspace_id
    ), 5);
