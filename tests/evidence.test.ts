import { describe, expect, it } from "vitest";
import { extractTaskHtml } from "../src/worker/lib/dataforseo-html";
import {
  decodedRawEvidenceBody,
  evidenceResponseHeaders,
} from "../src/worker/lib/evidence";
import { missingDefaultSecurityHeaders } from "../src/worker/lib/security-headers";

describe("evidence response headers", () => {
  it("opens captured HTML inline with strict isolation", () => {
    const headers = evidenceResponseHeaders("html", "snapshot-1");
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("content-disposition")).toContain("inline");
    expect(headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("content-security-policy")).toContain(
      "style-src-elem 'unsafe-inline' https://chatgpt.com",
    );
    expect(headers.get("content-security-policy")).toContain(
      "font-src https: data:",
    );
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("opens raw provider JSON inline", () => {
    const headers = evidenceResponseHeaders("raw", "snapshot-1");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.get("content-disposition")).toContain("inline");
    expect(headers.get("content-disposition")).not.toContain("attachment");
    expect(headers.has("content-security-policy")).toBe(false);
  });

  it("decodes gzipped raw evidence before returning JSON", async () => {
    const expected = JSON.stringify({ status: "ok", answer: "Visible JSON" });
    const source = new Response(expected).body;
    if (!source) throw new Error("Test response body is unavailable");
    const compressed = source.pipeThrough(new CompressionStream("gzip"));
    const metadata = new Headers({
      "content-encoding": "gzip",
      "content-length": "123",
    });

    const decoded = decodedRawEvidenceBody(compressed, "snapshot.json.gz", metadata);

    expect(await new Response(decoded).text()).toBe(expected);
    expect(metadata.has("content-encoding")).toBe(false);
    expect(metadata.has("content-length")).toBe(false);
  });
});

describe("global security header defaults", () => {
  it("does not overwrite route-specific isolation policies", () => {
    const responseHeaders = evidenceResponseHeaders("html", "snapshot-1");
    const missing = new Map(missingDefaultSecurityHeaders(responseHeaders));

    expect(missing.has("content-security-policy")).toBe(false);
    expect(missing.has("referrer-policy")).toBe(false);
    expect(missing.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });
});

describe("DataForSEO HTML evidence", () => {
  it("extracts the captured document from the provider JSON envelope", () => {
    expect(
      extractTaskHtml({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            result: [
              {
                items: [
                  {
                    page: 1,
                    html: "<!doctype html><html><body>Captured page</body></html>",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("<!doctype html><html><body>Captured page</body></html>");
  });

  it("selects the first captured page regardless of item ordering", () => {
    expect(
      extractTaskHtml({
        tasks: [
          {
            result: [
              {
                items: [
                  { page: 2, html: "<html>Second</html>" },
                  { page: 1, html: "<html>First</html>" },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("<html>First</html>");
  });

  it("rejects provider envelopes without an HTML document", () => {
    expect(() =>
      extractTaskHtml({
        status_message: "Ok.",
        tasks: [{ status_message: "No HTML.", result: [{ items: [] }] }],
      }),
    ).toThrow("No HTML.");
  });
});
