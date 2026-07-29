CREATE TABLE prompt_tags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  color_index INTEGER NOT NULL CHECK (color_index BETWEEN 0 AND 7),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, normalized_name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE tracked_query_tags (
  tracked_query_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tracked_query_id, tag_id),
  FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES prompt_tags(id) ON DELETE CASCADE
);

CREATE INDEX idx_prompt_tags_project
  ON prompt_tags(project_id, normalized_name);

CREATE INDEX idx_tracked_query_tags_tag
  ON tracked_query_tags(tag_id, tracked_query_id);
