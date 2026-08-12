import type { AdAssetQueueMessage } from "../../shared/contracts";
import { adAssetKey, allowedAdAssetUrl } from "../lib/ads";
import { nowIso } from "../lib/http";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

export interface AdAssetSource {
  sourceUrl: string | null;
  kind: "creative" | "favicon";
}

export async function registerAdAssetSources(
  env: Env,
  sources: AdAssetSource[],
): Promise<void> {
  const unique = new Map<string, AdAssetSource>();
  for (const source of sources) {
    if (!source.sourceUrl || !allowedAdAssetUrl(source.sourceUrl)) continue;
    unique.set(source.sourceUrl, source);
  }
  const queued: AdAssetQueueMessage[] = [];
  for (const source of unique.values()) {
    await env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO ad_assets (
        source_url, asset_key, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(
        source.sourceUrl,
        await adAssetKey(source.sourceUrl!),
        source.kind,
        nowIso(),
        nowIso(),
      )
      .run();
    const state = await env.CONTROL_DB.prepare(
      "SELECT status FROM ad_assets WHERE source_url = ?",
    )
      .bind(source.sourceUrl)
      .first<{ status: string }>();
    if (state?.status === "pending") {
      queued.push({ sourceUrl: source.sourceUrl!, kind: source.kind });
    }
  }
  for (let index = 0; index < queued.length; index += 100) {
    await env.AD_ASSET_QUEUE.sendBatch(
      queued.slice(index, index + 100).map((body) => ({ body })),
    );
  }
}

async function cacheAdAsset(
  env: Env,
  message: AdAssetQueueMessage,
): Promise<void> {
  const source = allowedAdAssetUrl(message.sourceUrl);
  if (!source) throw new Error("Ad asset source is not allowed");
  const row = await env.CONTROL_DB.prepare(
    "SELECT asset_key, status FROM ad_assets WHERE source_url = ?",
  )
    .bind(source.href)
    .first<{ asset_key: string; status: string }>();
  if (!row || row.status === "ready") return;

  const response = await fetch(source, {
    redirect: "error",
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Ad asset returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unsupported ad asset type: ${contentType ?? "missing"}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_ASSET_BYTES) throw new Error("Ad asset exceeds 5 MiB");

  let received = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_ASSET_BYTES) throw new Error("Ad asset exceeds 5 MiB");
      controller.enqueue(chunk);
    },
  });
  await env.EVIDENCE_BUCKET.put(row.asset_key, response.body.pipeThrough(limiter), {
    httpMetadata: { contentType },
    customMetadata: { sourceUrl: source.href, kind: message.kind },
  });
  await env.CONTROL_DB.prepare(
    `UPDATE ad_assets SET status = 'ready', content_type = ?, size_bytes = ?,
      attempts = attempts + 1, last_error = NULL, updated_at = ?
     WHERE source_url = ?`,
  )
    .bind(contentType, received, nowIso(), source.href)
    .run();
}

export async function adAssetBatch(
  env: Env,
  batch: MessageBatch<AdAssetQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await cacheAdAsset(env, message.body);
      message.ack();
    } catch (error) {
      await env.CONTROL_DB.prepare(
        `UPDATE ad_assets SET status = 'failed', attempts = attempts + 1,
          last_error = ?, updated_at = ? WHERE source_url = ?`,
      )
        .bind(String(error).slice(0, 1_000), nowIso(), message.body.sourceUrl)
        .run();
      console.error(JSON.stringify({
        level: "error",
        event: "ad_asset.cache_failed",
        sourceUrl: message.body.sourceUrl,
        error: String(error),
      }));
      message.retry({ delaySeconds: Math.min(300, 30 * 2 ** message.attempts) });
    }
  }
}
