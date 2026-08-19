import { describe, expect, it, vi } from "vitest";
import { isTransientD1ReadError, retryD1Read } from "../src/worker/lib/d1";

describe("D1 reads", () => {
  it("recognizes transient Cloudflare D1 failures", () => {
    expect(
      isTransientD1ReadError(new Error("D1_ERROR: Network connection lost.")),
    ).toBe(true);
    expect(isTransientD1ReadError(new Error("D1_ERROR: no such table"))).toBe(
      false,
    );
  });

  it("retries transient read failures", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("D1_ERROR: Network connection lost."))
      .mockResolvedValue("ok");

    await expect(
      retryD1Read(operation, { attempts: 2, delayMs: 0 }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent failures", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("D1_ERROR: no such table: snapshots"));

    await expect(
      retryD1Read(operation, { attempts: 3, delayMs: 0 }),
    ).rejects.toThrow("no such table");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
