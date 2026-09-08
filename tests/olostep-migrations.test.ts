// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function legacyDatabase(kind: "control" | "snapshot", migration: string) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(`migrations/${kind}`).filter((name) => name.endsWith(".sql") && name < migration).sort()) {
    db.exec(readFileSync(`migrations/${kind}/${name}`, "utf8"));
  }
  return db;
}

function migrate(db: DatabaseSync, path: string) {
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name").all();
  db.exec(`BEGIN; ${readFileSync(path, "utf8")} COMMIT;`);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name").all()).toEqual(objects);
}

const now = "2026-09-08T00:00:00.000Z";
function insert(db: DatabaseSync, table: string, row: Record<string, string | number>) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
}

describe("Olostep database upgrade", () => {
  it("preserves parent records, credentials, attempts, snapshots and leaf platform settings", () => {
    const db = legacyDatabase("control", "0039_olostep.sql");
    try {
      insert(db, "workspaces", { id: "w", name: "Workspace", public_base_url: "https://example.com", created_at: now, updated_at: now });
      insert(db, "projects", { id: "p", workspace_id: "w", name: "Project", created_at: now, updated_at: now });
      insert(db, "tracked_queries", { id: "q", project_id: "p", query_text: "Question", location_code: 2840, language_code: "en", schedule_cadence: "daily", schedule_time: "09:00", schedule_timezone: "UTC", next_run_at: now, shard_id: 0, created_at: now, updated_at: now });
      insert(db, "crawl_jobs", { id: "j", workspace_id: "w", project_id: "p", tracked_query_id: "q", shard_id: 0, run_type: "manual", delivery_method: "standard", status: "completed", scheduled_for: now, provider_tag: "tag", tracking_source: "gemini", capture_provider: "cloro", created_at: now, updated_at: now });
      insert(db, "capture_provider_credentials", { provider_account_id: "dataforseo:platform:v1", version: 1, algorithm: "aes-256-gcm-hkdf-sha256", ciphertext: "encrypted", nonce: "nonce", created_at: now });
      insert(db, "capture_provider_attempts", { id: "a", crawl_job_id: "j", provider_account_id: "dataforseo:platform:v1", provider: "dataforseo", role: "primary", attempt_number: 1, status: "completed", adapter_version: "dataforseo-v1", created_at: now, updated_at: now });
      insert(db, "snapshot_index", { id: "s", crawl_job_id: "j", workspace_id: "w", project_id: "p", tracked_query_id: "q", shard_id: 0, dataforseo_task_id: "task", captured_at: now, raw_r2_key: "raw", tracking_source: "gemini", capture_provider: "cloro", created_at: now });
      insert(db, "project_tracking_sources", { project_id: "p", source: "gemini", enabled: 1, created_at: now, updated_at: now });
      const tables = ["crawl_jobs", "snapshot_index", "capture_provider_accounts", "capture_provider_credentials", "capture_provider_attempts", "project_tracking_sources"];
      const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      migrate(db, "migrations/control/0039_olostep.sql");
      tables.forEach((table, index) => expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[index]));
      db.exec("UPDATE capture_provider_accounts SET provider = 'olostep'; UPDATE capture_provider_attempts SET provider = 'olostep'; UPDATE crawl_jobs SET capture_provider = 'olostep', tracking_source = 'copilot'; UPDATE snapshot_index SET capture_provider = 'olostep', tracking_source = 'perplexity'; UPDATE project_tracking_sources SET source = 'copilot';");
      expect(db.prepare("SELECT tracking_source, enabled FROM capture_provider_routes WHERE tracking_source IN ('perplexity', 'copilot') ORDER BY tracking_source").all()).toEqual([
        { tracking_source: "copilot", enabled: 0 }, { tracking_source: "perplexity", enabled: 0 },
      ]);
      expect(() => db.exec("UPDATE crawl_jobs SET tracking_source = 'invalid'")).toThrow();
      expect(() => db.exec("UPDATE capture_provider_accounts SET provider = 'invalid'")).toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("preserves snapshot children and restores the telemetry trigger", () => {
    const db = legacyDatabase("snapshot", "0009_olostep.sql");
    try {
      insert(db, "snapshots", { id: "s", crawl_job_id: "j", workspace_id: "w", project_id: "p", tracked_query_id: "q", dataforseo_task_id: "task", keyword: "Question", location_code: 2840, language_code: "en", captured_at: now, raw_r2_key: "raw", tracking_source: "gemini", capture_provider: "cloro", created_at: now });
      insert(db, "snapshot_sources", { id: "citation", snapshot_id: "s", ordinal: 0, title: "Retained citation" });
      const snapshot = db.prepare("SELECT * FROM snapshots").get();
      migrate(db, "migrations/snapshot/0009_olostep.sql");
      expect(db.prepare("SELECT * FROM snapshots").get()).toEqual(snapshot);
      expect(db.prepare("SELECT title FROM snapshot_sources").get()).toMatchObject({ title: "Retained citation" });
      db.exec("UPDATE snapshots SET capture_provider = 'olostep', tracking_source = 'perplexity'");
      expect(() => db.exec("UPDATE snapshots SET capture_provider = 'invalid'")).toThrow();
    } finally { db.close(); }
  });
});
