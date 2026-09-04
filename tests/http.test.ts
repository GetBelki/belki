import { describe, expect, it } from "vitest";
import {
  exclusiveDateEnd,
  InvalidContentLengthError,
  jsonParse,
  limitReadableBytes,
  readBoundedBody,
  RequestBodyTooLargeError,
} from "../src/worker/lib/http";

describe("HTTP utilities", () => {
  it("builds an exclusive UTC date bound", () => {
    expect(exclusiveDateEnd("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("falls back for malformed JSON", () => {
    expect(jsonParse("{", [])).toEqual([]);
  });

  it("counts streamed request bytes when content-length is absent", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("56"));
          controller.close();
        },
        // Node requires duplex for a streamed request body, but the Worker runtime does not.
      }),
      // @ts-expect-error Node-specific RequestInit extension used by the test runtime.
      duplex: "half",
    });
    await expect(readBoundedBody(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects invalid declared body lengths", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "ok",
    });
    await expect(readBoundedBody(request, 10)).rejects.toBeInstanceOf(InvalidContentLengthError);
  });

  it("limits decompressed or otherwise transformed streams", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    });
    await expect(new Response(limitReadableBytes(stream, 5)).arrayBuffer())
      .rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
