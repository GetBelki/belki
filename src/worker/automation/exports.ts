import type { ExportQueueMessage } from "../../shared/contracts";
import { exclusiveDateEnd, jsonParse, nowIso } from "../lib/http";

interface ExportRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  format: "csv" | "ndjson";
  filters_json: string;
}

function csvCell(value: unknown): string {
  const text = value == null
    ? ""
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? `${value}`
      : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function processExport(env: Env, exportId: string): Promise<void> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT id, workspace_id, project_id, format, filters_json
     FROM exports WHERE id = ? AND status = 'queued'`,
  )
    .bind(exportId)
    .first<ExportRow>();
  if (!row) return;
  await env.CONTROL_DB.prepare(
    "UPDATE exports SET status = 'processing', updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), row.id)
    .run();

  const filters = jsonParse<{ dateFrom?: string; dateTo?: string }>(
    row.filters_json,
    {},
  );
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const compressed = transform.readable.pipeThrough(new CompressionStream("gzip"));
  const key = `exports/${row.id}.${row.format}.gz`;
  let rowsWritten = 0;
  const encoder = new TextEncoder();

  const upload = env.EVIDENCE_BUCKET.put(key, compressed, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { exportId: row.id, format: row.format },
  });
  const produce = (async () => {
    if (row.format === "csv") {
      await writer.write(
        encoder.encode(
          "snapshot_id,project_id,query_id,captured_at,model,check_url,cited_domains,retrieved_domains,brand_entities,products\n",
        ),
      );
    }
    let cursor = "";
    while (true) {
      const clauses = ["workspace_id = ?", "id > ?"];
      const bindings: Array<string | number> = [row.workspace_id, cursor];
      if (row.project_id) {
        clauses.push("project_id = ?");
        bindings.push(row.project_id);
      }
      if (filters.dateFrom) {
        clauses.push("captured_at >= ?");
        bindings.push(`${filters.dateFrom}T00:00:00.000Z`);
      }
      if (filters.dateTo) {
        clauses.push("captured_at < ?");
        bindings.push(exclusiveDateEnd(filters.dateTo));
      }
      const page = await env.CONTROL_DB.prepare(
        `SELECT * FROM snapshot_index
         WHERE ${clauses.join(" AND ")}
         ORDER BY id LIMIT 500`,
      )
        .bind(...bindings)
        .all<Record<string, unknown>>();
      if (!page.results.length) break;
      for (const snapshot of page.results) {
        const line =
          row.format === "ndjson"
            ? `${JSON.stringify(snapshot)}\n`
            : `${[
                snapshot.id,
                snapshot.project_id,
                snapshot.tracked_query_id,
                snapshot.captured_at,
                snapshot.model,
                snapshot.check_url,
                snapshot.cited_domains_count,
                snapshot.retrieved_domains_count,
                snapshot.brand_entities_count,
                snapshot.products_count,
              ]
                .map(csvCell)
                .join(",")}\n`;
        await writer.write(encoder.encode(line));
        rowsWritten += 1;
      }
      const lastId = page.results.at(-1)?.id;
      cursor = typeof lastId === "string" ? lastId : "";
      if (page.results.length < 500) break;
    }
    await writer.close();
  })();

  try {
    await Promise.all([upload, produce]);
    const expires = new Date(
      Date.now() + Number(env.EXPORT_RETENTION_DAYS) * 86_400_000,
    ).toISOString();
    await env.CONTROL_DB.prepare(
      `UPDATE exports SET
        status = 'completed', r2_key = ?, row_count = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(key, rowsWritten, expires, nowIso(), row.id)
      .run();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await env.CONTROL_DB.prepare(
      `UPDATE exports SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(String(error).slice(0, 1000), nowIso(), row.id)
      .run();
    throw error;
  }
}

export async function exportBatch(
  env: Env,
  batch: MessageBatch<ExportQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processExport(env, message.body.exportId);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
