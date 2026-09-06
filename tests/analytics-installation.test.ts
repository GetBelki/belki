import { describe, expect, it } from "vitest";
import { analyticsInstallation } from "../src/worker/lib/traffic-installation";
import { trafficSnippet } from "../src/shared/traffic";
import { runInNewContext } from "node:vm";

describe("portable analytics installation", () => {
  it("defaults to the application's public origin and supports an independent CDN", () => {
    expect(analyticsInstallation({}, "https://belki.example/api/v1/traffic/p1/config")).toEqual({ origin: "https://belki.example", scriptUrl: "https://belki.example/belki-analytics.js", mode: "integrated", customScript: false });
    const installation = analyticsInstallation({ PUBLIC_APP_ORIGIN: "https://belki.example", PUBLIC_ANALYTICS_ORIGIN: "https://analytics.example", PUBLIC_ANALYTICS_SCRIPT_URL: "https://cdn.example/belki-analytics.js" }, "https://internal.example");
    expect(installation).toMatchObject({ origin: "https://analytics.example", mode: "separate", customScript: true });
    const snippet = trafficSnippet(installation, "public-key");
    expect(snippet).toContain('data-api="https://analytics.example"');
    expect(snippet).toContain('src="https://cdn.example/belki-analytics.js"');
    expect(snippet).not.toContain("getbelki.com");
  });
  it("rejects malformed deployment URLs and safely escapes generated attributes", () => {
    for (const origin of ["http://production.example", "https://user:password@analytics.example", "https://analytics.example/path", "https://analytics.example/?x=1", "javascript:alert(1)"]) {
      expect(() => analyticsInstallation({ PUBLIC_ANALYTICS_ORIGIN: origin }, "https://belki.example")).toThrow();
    }
    expect(analyticsInstallation({}, "http://localhost:5173").origin).toBe("http://localhost:5173");
    expect(trafficSnippet(analyticsInstallation({}, "https://belki.example"), '"><script>alert(1)</script>')).not.toContain('data-site=""><script>');
  });
  it("queues early conversion calls with their time and URL before the async SDK loads", () => {
    const snippet = trafficSnippet(analyticsInstallation({}, "https://belki.example"), "key");
    const win = {} as { belki: { q: unknown[]; track: (name: string) => void } };
    runInNewContext(snippet.split("<script>")[1]!.split("</script>")[0]!, { window: win, location: { href: "https://example.com/?utm_source=chatgpt" }, Date: { now: () => 12345 } });
    win.belki.track("signup_completed");
    expect(win.belki.q).toEqual([{ name: "signup_completed", at: 12345, url: "https://example.com/?utm_source=chatgpt" }]);
  });
});
