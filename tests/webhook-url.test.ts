import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl } from "../src/worker/lib/webhook-url";

describe("outbound webhook URL policy", () => {
  it("accepts public HTTPS destinations", () => {
    expect(assertSafeWebhookUrl("https://hooks.example.com/events").href)
      .toBe("https://hooks.example.com/events");
  });

  it.each([
    "http://hooks.example.com/events",
    "https://localhost/events",
    "https://service.internal/events",
    "https://127.0.0.1/events",
    "https://10.2.3.4/events",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/events",
    "https://[::1]/events",
    "https://[fd00::1]/events",
    "https://[fe80::1]/events",
    "https://user:password@hooks.example.com/events",
  ])("rejects a non-public destination: %s", (url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow("Only public HTTPS webhook targets");
  });
});
