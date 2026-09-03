import { describe, expect, it } from "vitest";
import {
  activeProjectsFirst,
  projectDataNavigationVisible,
  projectChangeDestination,
  trackingSourcesForPath,
  trackingSourceChangeDestination,
} from "../src/app/lib/project-navigation";

describe("project switcher order", () => {
  it("places active projects first while preserving each group's existing order", () => {
    const projects = [
      { id: "pets", paused_at: "2026-09-01T10:00:00.000Z" },
      { id: "logiscenter", paused_at: "2026-09-02T10:00:00.000Z" },
      { id: "canon", paused_at: "2026-09-03T10:00:00.000Z" },
      { id: "modulor", paused_at: null },
      { id: "rebill" },
    ];

    expect(activeProjectsFirst(projects).map((project) => project.id)).toEqual([
      "modulor",
      "rebill",
      "pets",
      "logiscenter",
      "canon",
    ]);
    expect(projects.map((project) => project.id)).toEqual([
      "pets",
      "logiscenter",
      "canon",
      "modulor",
      "rebill",
    ]);
  });
});

describe("data navigation visibility", () => {
  it("hides Ads and Shopping until the selected project has matching data", () => {
    expect(projectDataNavigationVisible("/ads", "/", { ads: 0, products: 0 })).toBe(false);
    expect(projectDataNavigationVisible("/shopping", "/", { ads: 0, products: 0 })).toBe(false);
  });

  it("shows data sections after historical results have been captured", () => {
    expect(projectDataNavigationVisible("/ads", "/", { ads: 1, products: 0 })).toBe(true);
    expect(projectDataNavigationVisible("/shopping", "/", { ads: 0, products: 2 })).toBe(true);
  });

  it("keeps a directly opened data section visible while it is active", () => {
    expect(projectDataNavigationVisible("/ads", "/ads", { ads: 0, products: 0 })).toBe(true);
    expect(projectDataNavigationVisible("/shopping", "/shopping/product", { ads: 0, products: 0 })).toBe(true);
  });
});

describe("project navigation", () => {
  it.each([
    "/prompts/query-1",
    "/prompts/query-1/snapshots/snapshot-1",
    "/queries/query-1",
    "/queries/query-1/snapshots/snapshot-1",
    "/snapshots/snapshot-1",
  ])("returns to the prompt list when changing project from %s", (pathname) => {
    expect(projectChangeDestination(pathname)).toBe("/prompts");
  });

  it("returns to citation sources when changing project from a source detail", () => {
    expect(projectChangeDestination("/citations/reddit.com")).toBe("/citations");
  });

  it("returns to related queries when changing project from a query detail", () => {
    expect(projectChangeDestination("/related-queries/query-key")).toBe(
      "/related-queries",
    );
  });

  it("returns to shopping when changing project from a product detail", () => {
    expect(projectChangeDestination("/shopping/product-key")).toBe("/shopping");
  });

  it.each([
    "/",
    "/prompts",
    "/prompts/library",
    "/snapshots",
    "/citations",
    "/related-queries",
    "/brands",
    "/shopping",
    "/settings",
  ])("preserves project-level section navigation on %s", (pathname) => {
    expect(projectChangeDestination(pathname)).toBeNull();
  });
});

describe("tracking source navigation", () => {
  it("shows only sources with Shopping data on Shopping routes", () => {
    expect(trackingSourcesForPath(
      "/shopping",
      ["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"],
      {
        chatgpt: { ads: 2, products: 8 },
        gemini: { ads: 0, products: 0 },
        google_ai_mode: { ads: 0, products: 3 },
      },
    )).toEqual(["chatgpt", "google_ai_mode"]);
  });

  it("shows only sources with Ads data on Ads routes", () => {
    expect(trackingSourcesForPath(
      "/ads/advertiser-key",
      ["chatgpt", "gemini", "google_ai_mode"],
      {
        chatgpt: { ads: 4, products: 2 },
        gemini: { ads: 0, products: 7 },
        google_ai_mode: { ads: 1, products: 0 },
      },
    )).toEqual(["chatgpt", "google_ai_mode"]);
  });

  it("keeps every enabled source on non-commerce routes", () => {
    expect(trackingSourcesForPath(
      "/prompts",
      ["chatgpt", "gemini"],
      {},
    )).toEqual(["chatgpt", "gemini"]);
  });

  it.each([
    "/prompts/query-1/snapshots/snapshot-1",
    "/queries/query-1/snapshots/snapshot-1",
  ])("returns to the selected prompt from %s", (pathname) => {
    expect(trackingSourceChangeDestination(pathname)).toBe(
      "/prompts/query-1",
    );
  });

  it("returns to response history from a standalone snapshot", () => {
    expect(trackingSourceChangeDestination("/snapshots/snapshot-1")).toBe(
      "/snapshots",
    );
  });

  it.each([
    ["/shopping/product-key", "/shopping"],
    ["/ads/advertiser-key", "/ads"],
  ])("returns to the list when changing source from %s", (pathname, destination) => {
    expect(trackingSourceChangeDestination(pathname)).toBe(destination);
  });

  it.each([
    "/",
    "/prompts",
    "/prompts/query-1",
    "/related-queries/query-key",
    "/citations/source.example",
  ])("keeps source-aware routes mounted for %s", (pathname) => {
    expect(trackingSourceChangeDestination(pathname)).toBeNull();
  });
});
