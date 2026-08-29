// Capture-specific DataForSEO boundary. Product enrichment and locale catalog
// calls remain separate product capabilities, while answer capture goes through
// this module so the ingestion orchestrator does not depend on provider internals.
import { hmac, timingSafeTextEqual } from "../lib/crypto";

export async function dataForSeoWebhookToken(env: Env): Promise<string> {
  return hmac("belki:dataforseo:webhook:v1", env.APP_CRYPTO_KEY);
}

export async function verifyDataForSeoWebhookToken(
  env: Env,
  received: string,
): Promise<boolean> {
  if (await timingSafeTextEqual(received, await dataForSeoWebhookToken(env))) {
    return true;
  }
  const legacy: unknown = (env as unknown as Record<string, unknown>).DATAFORSEO_WEBHOOK_TOKEN;
  return typeof legacy === "string"
    && legacy.length > 0
    && await timingSafeTextEqual(received, legacy);
}

export {
  dataForSeoTask,
  getTaskHtml,
  getTaskResult,
  getTasksReady,
  postLiveAdvanced,
  postStandardTasks,
  type StandardTaskInput,
} from "../lib/dataforseo";
