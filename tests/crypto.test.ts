import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/worker/lib/crypto";

describe("password hashing", () => {
  it("uses an iteration count supported by Cloudflare Workers", async () => {
    const result = await hashPassword("correct horse battery staple");

    expect(result).toMatchObject({
      algorithm: "pbkdf2-sha256",
      iterations: 100_000,
    });
    expect(result.salt).not.toHaveLength(0);
    expect(result.passwordHash).not.toHaveLength(0);
  });

  it("verifies the password against the stored hashing parameters", async () => {
    const result = await hashPassword("correct horse battery staple");

    await expect(
      verifyPassword(
        "correct horse battery staple",
        result.salt,
        result.iterations,
        result.passwordHash,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(
        "wrong password",
        result.salt,
        result.iterations,
        result.passwordHash,
      ),
    ).resolves.toBe(false);
  });
});
