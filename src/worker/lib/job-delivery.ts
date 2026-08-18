import type { TrackingSource, UsageSku } from "../../shared/contracts";

export type JobDeliveryMethod = "standard" | "standard_priority" | "live";

export interface JobDeliveryPlan {
  captureHtml: boolean;
  deliveryMethod: JobDeliveryMethod;
  queue: "standard" | "live";
  sku: UsageSku;
}

function chatGptPageRetention(
  source: TrackingSource,
  requested: boolean,
): boolean {
  return source === "chatgpt" && requested;
}

/**
 * Scheduled collection always uses the normal-priority queue. ChatGPT page
 * retention is an independent result-fetch step and does not require provider
 * priority 2.
 */
export function scheduledJobDelivery(
  source: TrackingSource,
  retainOriginalPage: boolean,
): JobDeliveryPlan {
  return {
    captureHtml: chatGptPageRetention(source, retainOriginalPage),
    deliveryMethod: "standard",
    queue: "standard",
    sku: "llm_standard",
  };
}

/**
 * Manual runs remain immediate unless ChatGPT page retention requires the
 * queued task endpoint. Retained manual runs use normal priority as well.
 */
export function manualJobDelivery(
  source: TrackingSource,
  retainOriginalPage: boolean,
): JobDeliveryPlan {
  const captureHtml = chatGptPageRetention(source, retainOriginalPage);
  return captureHtml
    ? {
        captureHtml,
        deliveryMethod: "standard",
        queue: "standard",
        sku: "llm_standard",
      }
    : {
        captureHtml,
        deliveryMethod: "live",
        queue: "live",
        sku: "llm_live",
      };
}
