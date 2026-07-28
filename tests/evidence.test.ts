import { describe, expect, it } from "vitest";
import { evidenceResponseHeaders } from "../src/worker/lib/evidence";

describe("evidence response headers", () => {
  it("opens captured HTML inline with strict isolation", () => {
    const headers = evidenceResponseHeaders("html", "snapshot-1");
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("content-disposition")).toContain("inline");
    expect(headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps raw provider JSON downloadable", () => {
    const headers = evidenceResponseHeaders("raw", "snapshot-1");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.get("content-disposition")).toContain("attachment");
    expect(headers.has("content-security-policy")).toBe(false);
  });
});
