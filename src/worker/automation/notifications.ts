import type { NotificationQueueMessage } from "../../shared/contracts";
import { hmac } from "../lib/crypto";
import { nowIso } from "../lib/http";

interface DeliveryRow {
  id: string;
  alert_id: string;
  url: string;
  destination_id: string;
  attempts: number;
  event_type: string;
  title: string;
  message: string;
  payload_json: string;
  created_at: string;
}

export async function deliverWebhook(env: Env, deliveryId: string): Promise<void> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT
      d.id, d.alert_id, d.attempts, w.url, w.id AS destination_id,
      a.event_type, a.title, a.message, a.payload_json, a.created_at
    FROM webhook_deliveries d
    JOIN webhook_destinations w ON w.id = d.destination_id
    JOIN alerts a ON a.id = d.alert_id
    WHERE d.id = ? AND d.status != 'delivered' AND w.is_enabled = 1`,
  )
    .bind(deliveryId)
    .first<DeliveryRow>();
  if (!row) return;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: row.alert_id,
    type: row.event_type,
    title: row.title,
    message: row.message,
    data: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  });
  const signingSecret = await hmac(row.destination_id, env.APP_CRYPTO_KEY);
  const signature = await hmac(`${timestamp}.${body}`, signingSecret);
  const response = await fetch(row.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "AI-Tracker-Webhook/1.0",
      "x-ai-tracker-event-id": row.alert_id,
      "x-ai-tracker-timestamp": timestamp,
      "x-ai-tracker-signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
  await env.CONTROL_DB.prepare(
    `UPDATE webhook_deliveries SET
      status = 'delivered', attempts = attempts + 1, response_status = ?,
      delivered_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(response.status, nowIso(), nowIso(), row.id)
    .run();
}

export async function notificationBatch(
  env: Env,
  batch: MessageBatch<NotificationQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await deliverWebhook(env, message.body.deliveryId);
      message.ack();
    } catch (error) {
      await env.CONTROL_DB.prepare(
        `UPDATE webhook_deliveries SET
          status = 'failed', attempts = attempts + 1, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(String(error).slice(0, 1000), nowIso(), message.body.deliveryId)
        .run();
      message.retry({ delaySeconds: Math.min(3600, 60 * 2 ** message.attempts) });
    }
  }
}
