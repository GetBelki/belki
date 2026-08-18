import { describe, expect, it } from "vitest";
import {
  manualJobDelivery,
  scheduledJobDelivery,
} from "../src/worker/lib/job-delivery";

describe("job delivery planning", () => {
  it("retains scheduled ChatGPT pages without paying for high priority", () => {
    expect(scheduledJobDelivery("chatgpt", true)).toEqual({
      captureHtml: true,
      deliveryMethod: "standard",
      queue: "standard",
      sku: "llm_standard",
    });
  });

  it("does not leak ChatGPT page retention into other tracking sources", () => {
    for (const source of ["gemini", "google_ai_mode", "google_ai_overview"] as const) {
      expect(scheduledJobDelivery(source, true).captureHtml).toBe(false);
      expect(manualJobDelivery(source, true)).toMatchObject({
        captureHtml: false,
        deliveryMethod: "live",
        queue: "live",
        sku: "llm_live",
      });
    }
  });

  it("keeps retained manual ChatGPT runs queued at normal priority", () => {
    expect(manualJobDelivery("chatgpt", true)).toEqual({
      captureHtml: true,
      deliveryMethod: "standard",
      queue: "standard",
      sku: "llm_standard",
    });
  });
});
