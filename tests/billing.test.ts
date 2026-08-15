import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../src/worker/lib/stripe-signature";

describe("Stripe webhook verification", () => {
  it("accepts the signed raw payload and rejects tampering", async () => {
    const payload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" });
    const secret = "whsec_test_secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const header = `t=${timestamp},v1=${signature}`;
    await expect(verifyStripeSignature(payload, header, secret)).resolves.toBe(true);
    await expect(verifyStripeSignature(`${payload}x`, header, secret)).resolves.toBe(false);
  });

  it("rejects replayed signatures outside the five-minute tolerance", async () => {
    const payload = "{}";
    const secret = "whsec_test_secret";
    const timestamp = Math.floor(Date.now() / 1000) - 601;
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    await expect(
      verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, secret),
    ).resolves.toBe(false);
  });
});
