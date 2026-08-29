import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Belki brand color", () => {
  it("uses the brand blue for product accents instead of the legacy violet", () => {
    const files = [
      "src/app/styles.css",
      "src/app/pages/ads.tsx",
      "src/app/pages/insights.tsx",
      "src/app/pages/main.tsx",
      "src/app/pages/operator-insights.tsx",
    ];
    const sources = files
      .map((file) => readFileSync(resolve(file), "utf8"))
      .join("\n");
    const styles = readFileSync(resolve("src/app/styles.css"), "utf8");

    expect(styles).toContain("--brand: #1e73be;");
    expect(styles).toMatch(/\.onboarding-heading > span \{ color: var\(--brand\)/);
    expect(styles).not.toContain("--violet");
    expect(sources).not.toMatch(/#(?:7557ff|7c3aed|9333ea|4f46e5)\b/i);
  });
});
