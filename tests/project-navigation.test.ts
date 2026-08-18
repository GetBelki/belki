import { describe, expect, it } from "vitest";
import {
  projectDataNavigationVisible,
  projectChangeDestination,
  trackingSourceChangeDestination,
} from "../src/app/lib/project-navigation";

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
    "/",
    "/prompts",
    "/prompts/query-1",
    "/related-queries/query-key",
    "/citations/source.example",
  ])("keeps source-aware routes mounted for %s", (pathname) => {
    expect(trackingSourceChangeDestination(pathname)).toBeNull();
  });
});
