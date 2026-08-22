import { describe, expect, it } from "vitest";
import {
  fetchDomainFavicon,
  type FaviconFetcher,
} from "../src/worker/lib/favicon";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("favicon proxy", () => {
  it("returns the first successful image response", async () => {
    const calls: string[] = [];
    const fetcher: FaviconFetcher = (input) => {
      calls.push(requestUrl(input));
      return Promise.resolve(
        new Response("duck-icon", {
          headers: { "content-type": "image/png" },
        }),
      );
    };

    const response = await fetchDomainFavicon("Example.com", fetcher);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("duck-icon");
    expect(calls).toEqual([
      "https://icons.duckduckgo.com/ip3/example.com.ico",
    ]);
  });

  it("rejects DuckDuckGo's 404 image and redirects to Favicon.im", async () => {
    const calls: string[] = [];
    const fetcher: FaviconFetcher = (input) => {
      const url = requestUrl(input);
      calls.push(url);
      return Promise.resolve(
        new Response("placeholder", {
          status: 404,
          headers: { "content-type": "image/png" },
        }),
      );
    };

    const response = await fetchDomainFavicon("logiscenter.com", fetcher);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://favicon.im/logiscenter.com?larger=true&throw-error-on-404=true",
    );
    expect(calls).toEqual([
      "https://icons.duckduckgo.com/ip3/logiscenter.com.ico",
    ]);
  });

  it("redirects when DuckDuckGo has no icon", async () => {
    const response = await fetchDomainFavicon(
      "logiscenter.com",
      () => Promise.resolve(new Response(null, { status: 404 })),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("rejects invalid domains without contacting providers", async () => {
    let called = false;
    const response = await fetchDomainFavicon("https://example.com/path", () => {
      called = true;
      return Promise.resolve(new Response(null));
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("redirects after oversized and non-image provider responses", async () => {
    for (const response of [
      new Response("large", {
        headers: {
          "content-length": String(1024 * 1024 + 1),
          "content-type": "image/png",
        },
      }),
      new Response("html", {
        headers: { "content-type": "text/html" },
      }),
    ]) {
      let calls = 0;
      const result = await fetchDomainFavicon("example.com", () => {
        calls += 1;
        return Promise.resolve(response);
      });

      expect(result.status).toBe(302);
      expect(calls).toBe(1);
    }
  });
});
