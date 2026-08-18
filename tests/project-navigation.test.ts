import { describe, expect, it } from "vitest";
import {
  projectChangeDestination,
  trackingSourceChangeDestination,
} from "../src/app/lib/project-navigation";

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
