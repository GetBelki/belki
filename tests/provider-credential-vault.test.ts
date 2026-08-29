import { describe, expect, it } from "vitest";
import {
  decryptProviderCredential,
  encryptProviderCredential,
} from "../src/worker/lib/provider-credential-vault";

describe("provider credential vault", () => {
  const secret = "installation-master-secret-with-enough-entropy";
  const context = {
    accountId: "5d02499f-aae0-4824-a664-85eff274bd31",
    provider: "cloro" as const,
    version: 1,
  };

  it("encrypts and decrypts a provider credential without plaintext storage", async () => {
    const input = {
      provider: "cloro" as const,
      credentials: { apiKey: "sk_live_example" },
    };
    const encrypted = await encryptProviderCredential(secret, context, input);

    expect(encrypted.algorithm).toBe("aes-256-gcm-hkdf-sha256");
    expect(encrypted.ciphertext).not.toContain(input.credentials.apiKey);
    await expect(decryptProviderCredential(secret, context, encrypted)).resolves.toEqual(input);
  });

  it("binds ciphertext to the account, provider, and credential version", async () => {
    const encrypted = await encryptProviderCredential(secret, context, {
      provider: "cloro",
      credentials: { apiKey: "sk_live_example" },
    });

    await expect(decryptProviderCredential(secret, {
      ...context,
      accountId: "e3afe494-fe90-4722-ac19-fcb2af875236",
    }, encrypted)).rejects.toThrow();
    await expect(decryptProviderCredential(secret, {
      ...context,
      version: 2,
    }, encrypted)).rejects.toThrow();
  });
});
