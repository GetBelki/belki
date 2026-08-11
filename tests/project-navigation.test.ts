import { describe, expect, it } from "vitest";
import { projectChangeDestination } from "../src/app/lib/project-navigation";

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

  it("returns to shopping when changing project from a product detail", () => {
    expect(projectChangeDestination("/shopping/product-key")).toBe("/shopping");
  });

  it.each([
    "/",
    "/prompts",
    "/prompts/library",
    "/snapshots",
    "/citations",
    "/brands",
    "/shopping",
    "/settings",
  ])("preserves project-level section navigation on %s", (pathname) => {
    expect(projectChangeDestination(pathname)).toBeNull();
  });
});
