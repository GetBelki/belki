import { z } from "zod";

const TaskHtmlResponseSchema = z
  .object({
    status_message: z.string().optional(),
    tasks: z
      .array(
        z
          .object({
            status_message: z.string().optional(),
            result: z
              .array(
                z
                  .object({
                    items: z
                      .array(
                        z
                          .object({
                            page: z.number().optional(),
                            html: z.string().nullable().optional(),
                          })
                          .passthrough(),
                      )
                      .nullable()
                      .optional(),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const REMOVED_CAPTURE_ELEMENTS = [
  "script",
  "iframe",
  "frame",
  "object",
  "embed",
  "portal",
  "base",
] as const;

const URL_ATTRIBUTES = [
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "xlink:href",
] as const;

interface CapturedHtmlElement {
  readonly attributes: IterableIterator<string[]>;
  readonly tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  remove(): void;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

interface CapturedHtmlElementHandlers {
  element(element: CapturedHtmlElement): void;
}

interface CapturedHtmlRewriter {
  on(selector: string, handlers: CapturedHtmlElementHandlers): CapturedHtmlRewriter;
  transform(response: Response): Response;
}

interface CapturedHtmlRewriterConstructor {
  new (): CapturedHtmlRewriter;
}

function isExecutableUrl(value: string): boolean {
  const normalized = Array.from(value)
    .filter((character) => character.charCodeAt(0) > 0x20)
    .join("")
    .toLowerCase();
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:text/html")
  );
}

const removeCapturedElement: CapturedHtmlElementHandlers = {
  element(element) {
    element.remove();
  },
};

const removeCapturedHttpEquiv: CapturedHtmlElementHandlers = {
  element(element) {
    element.remove();
  },
};

const makeCapturedElementInert: CapturedHtmlElementHandlers = {
  element(element) {
    for (const attribute of element.attributes) {
      const attributeName = attribute[0];
      if (!attributeName) continue;
      const normalizedName = attributeName.toLowerCase();
      if (
        normalizedName.startsWith("on") ||
        normalizedName === "autofocus" ||
        normalizedName === "nonce" ||
        normalizedName === "integrity"
      ) {
        element.removeAttribute(attributeName);
      }
    }

    for (const attributeName of URL_ATTRIBUTES) {
      const value = element.getAttribute(attributeName);
      if (value && isExecutableUrl(value)) {
        element.removeAttribute(attributeName);
      }
    }

    if (element.tagName === "a" && element.hasAttribute("href")) {
      element.setAttribute("rel", "noopener noreferrer");
      element.setAttribute("target", "_blank");
    }
  },
};

const filterCapturedLink: CapturedHtmlElementHandlers = {
  element(element) {
    const relationship = element.getAttribute("rel")?.toLowerCase() ?? "";
    if (!relationship.split(/\s+/).includes("stylesheet")) {
      element.remove();
    }
  },
};

let capturedHtmlRewriter: CapturedHtmlRewriter | undefined;

function getCapturedHtmlRewriter(): CapturedHtmlRewriter {
  if (capturedHtmlRewriter) return capturedHtmlRewriter;

  const Rewriter = (
    globalThis as typeof globalThis & {
      HTMLRewriter: CapturedHtmlRewriterConstructor;
    }
  ).HTMLRewriter;
  const rewriter = new Rewriter();
  for (const tagName of REMOVED_CAPTURE_ELEMENTS) {
    rewriter.on(tagName, removeCapturedElement);
  }
  rewriter.on("link", filterCapturedLink);
  rewriter.on("meta[http-equiv]", removeCapturedHttpEquiv);
  rewriter.on("*", makeCapturedElementInert);
  capturedHtmlRewriter = rewriter;
  return rewriter;
}

/**
 * Converts a captured third-party page into a static replay. The CSP remains
 * the final security boundary; this transformation prevents the browser from
 * attempting blocked scripts, frames, preloads, and executable attributes.
 */
export function stripExecutableCapturedHtml(html: string): string {
  return html
    .replace(
      /<(script|iframe|frame|object|embed|portal)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(
      /<(script|iframe|frame|object|embed|portal)\b[^>]*\/?\s*>/gi,
      "",
    );
}

export async function sanitizeCapturedHtmlResponse(
  response: Response,
): Promise<Response> {
  const sanitizedSource = stripExecutableCapturedHtml(await response.text());
  const rewritten = new Response(sanitizedSource, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  return getCapturedHtmlRewriter().transform(rewritten);
}

export function extractTaskHtml(payload: unknown): string {
  const parsed = TaskHtmlResponseSchema.parse(payload);
  for (const task of parsed.tasks) {
    for (const result of task.result ?? []) {
      const item = [...(result.items ?? [])]
        .sort((left, right) => (left.page ?? 1) - (right.page ?? 1))
        .find((candidate) => candidate.html?.trim().length);
      if (item?.html) return item.html;
    }
  }
  const message =
    parsed.tasks.find((task) => task.status_message)?.status_message ??
    parsed.status_message ??
    "DataForSEO returned no HTML page";
  throw new Error(message);
}
