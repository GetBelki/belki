import { describe, expect, it } from "vitest";
import { normalizePublicAppOrigin } from "../src/shared/public-origin";
import {
  configuredPublicAppOrigin,
  requestPublicAppOrigin,
  workspacePublicAppOrigin,
} from "../src/worker/lib/public-origin";

describe("public application origin", () => {
  it("normalizes HTTPS origins and local development origins", () => {
    expect(normalizePublicAppOrigin(" https://tracker.example.com/ "))
      .toBe("https://tracker.example.com");
    expect(normalizePublicAppOrigin("http://localhost:5173"))
      .toBe("http://localhost:5173");
  });

  it.each([
    "http://tracker.example.com",
    "https://user:password@tracker.example.com",
    "https://tracker.example.com/app",
    "https://tracker.example.com/?source=test",
    "https://tracker.example.com/#dashboard",
    "not a URL",
  ])("rejects unsafe or non-origin values: %s", (value) => {
    expect(() => normalizePublicAppOrigin(value)).toThrow();
  });

  it("uses deployment configuration before workspace and request origins", () => {
    const managed = { PUBLIC_APP_ORIGIN: "https://managed.example.com" };
    expect(configuredPublicAppOrigin(managed)).toBe("https://managed.example.com");
    expect(workspacePublicAppOrigin(managed, "https://stored.example.com"))
      .toBe("https://managed.example.com");
    expect(requestPublicAppOrigin(managed, "https://request.example.com/setup"))
      .toBe("https://managed.example.com");
  });

  it("uses the stored workspace origin when deployment configuration is empty", () => {
    expect(workspacePublicAppOrigin(
      { PUBLIC_APP_ORIGIN: "" },
      "https://stored.example.com/",
    )).toBe("https://stored.example.com");
  });
});
