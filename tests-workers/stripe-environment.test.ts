import { describe, expect, it } from "vitest";
import { assertStripeLivemode, stripeEnvironment, stripeSecret } from "../src/worker/lib/stripe";

describe("Stripe environment isolation", () => {
  it("accepts only keys matching the configured test/live environment", () => {
    const testEnv = {
      STRIPE_ENVIRONMENT: "test",
      STRIPE_SECRET_KEY: "sk_test_placeholder",
    };
    const liveEnv = {
      STRIPE_ENVIRONMENT: "live",
      STRIPE_SECRET_KEY: "sk_live_placeholder",
    };

    expect(stripeEnvironment(testEnv)).toBe("test");
    expect(stripeSecret(testEnv)).toBe("sk_test_placeholder");
    expect(stripeSecret(liveEnv)).toBe("sk_live_placeholder");
    expect(() => stripeSecret({ ...testEnv, STRIPE_SECRET_KEY: "sk_live_placeholder" }))
      .toThrowError(/does not match/u);
  });

  it("rejects resources from the opposite Stripe environment", () => {
    const testEnv = { STRIPE_ENVIRONMENT: "test" };
    expect(() => assertStripeLivemode(testEnv, false)).not.toThrow();
    expect(() => assertStripeLivemode(testEnv, true)).toThrowError(/different test\/live environment/u);
    expect(() => assertStripeLivemode(testEnv, null)).toThrowError(/different test\/live environment/u);
  });
});
