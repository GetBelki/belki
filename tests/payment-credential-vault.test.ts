import { describe, expect, it } from "vitest";
import {
  decryptPaymentCredential,
  encryptPaymentCredential,
} from "../src/worker/lib/payment-credential-vault";

describe("payment credential vault", () => {
  const secret = "installation-master-secret-with-enough-entropy";
  const context = {
    accountId: "stripe-account-1",
    provider: "stripe" as const,
    environment: "test" as const,
    version: 1,
  };
  const input = {
    provider: "stripe" as const,
    credentials: {
      secretKey: "sk_test_example_secret",
      webhookSecret: "whsec_example_secret",
    },
  };

  it("encrypts payment credentials without plaintext storage", async () => {
    const encrypted = await encryptPaymentCredential(secret, context, input);

    expect(encrypted.algorithm).toBe("aes-256-gcm-hkdf-sha256");
    expect(encrypted.ciphertext).not.toContain(input.credentials.secretKey);
    expect(encrypted.ciphertext).not.toContain(input.credentials.webhookSecret);
    await expect(decryptPaymentCredential(secret, context, encrypted)).resolves.toEqual(input);
  });

  it("binds ciphertext to account, provider, environment, and version", async () => {
    const encrypted = await encryptPaymentCredential(secret, context, input);

    await expect(decryptPaymentCredential(secret, {
      ...context,
      accountId: "stripe-account-2",
    }, encrypted)).rejects.toThrow();
    await expect(decryptPaymentCredential(secret, {
      ...context,
      environment: "live",
    }, encrypted)).rejects.toThrow();
    await expect(decryptPaymentCredential(secret, {
      ...context,
      version: 2,
    }, encrypted)).rejects.toThrow();
  });

  it("encrypts Dodo API and Standard Webhooks secrets with the same vault", async () => {
    const dodoContext = {
      accountId: "dodo-account-1",
      provider: "dodo" as const,
      environment: "test" as const,
      version: 1,
    };
    const dodoInput = {
      provider: "dodo" as const,
      credentials: {
        apiKey: "dodo_test_example_secret",
        webhookSecret: "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      },
    };
    const encrypted = await encryptPaymentCredential(secret, dodoContext, dodoInput);

    expect(encrypted.ciphertext).not.toContain(dodoInput.credentials.apiKey);
    await expect(decryptPaymentCredential(secret, dodoContext, encrypted)).resolves.toEqual(dodoInput);
  });
});
