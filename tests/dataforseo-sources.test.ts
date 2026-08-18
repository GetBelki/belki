import { describe, expect, it } from "vitest";
import {
  dataForSeoLanguageCode,
  dataForSeoTask,
} from "../src/worker/lib/dataforseo";

const input = {
  keyword: "best dog food",
  location_code: 2_840,
  language_code: "en",
  force_web_search: true,
  priority: 1 as const,
  expand_citations: true,
  tag: "signed-tag",
  postback_url: "https://app.example.com/api/webhooks/dataforseo/chatgpt",
  postback_data: "advanced" as const,
};

describe("DataForSEO source task mapping", () => {
  it("keeps ChatGPT web-search controls", () => {
    expect(dataForSeoTask("chatgpt", input)).toMatchObject({
      force_web_search: true,
      expand_citations: true,
    });
  });

  it("does not send ChatGPT-only controls to Gemini", () => {
    const task = dataForSeoTask("gemini", input);
    expect(task).not.toHaveProperty("force_web_search");
    expect(task).toHaveProperty("expand_citations", true);
  });

  it("maps Google AI Mode to desktop SERP task options", () => {
    expect(dataForSeoTask("google_ai_mode", input)).toMatchObject({
      device: "desktop",
      os: "windows",
      priority: 1,
    });
  });

  it("requests asynchronous AI Overview expansion for Google Organic", () => {
    expect(dataForSeoTask("google_ai_overview", input)).toMatchObject({
      device: "desktop",
      os: "windows",
      depth: 10,
      load_async_ai_overview: true,
    });
  });

  it("normalizes canonical language codes at each provider boundary", () => {
    expect(dataForSeoLanguageCode("chatgpt", "nb")).toBe("no");
    expect(dataForSeoLanguageCode("gemini", "pt")).toBe("pt-BR");
    expect(dataForSeoLanguageCode("gemini", "tl")).toBe("fil");
    expect(dataForSeoLanguageCode("google_ai_mode", "pt")).toBe("pt-BR");
    expect(dataForSeoLanguageCode("google_ai_mode", "tl")).toBe("fil");
    expect(dataForSeoLanguageCode("google_ai_overview", "pt")).toBe("pt");
    expect(dataForSeoLanguageCode("google_ai_overview", "tl")).toBe("tl");
  });

  it("uses provider language codes in standard task payloads", () => {
    expect(dataForSeoTask("gemini", { ...input, language_code: "pt" }))
      .toHaveProperty("language_code", "pt-BR");
    expect(dataForSeoTask("google_ai_mode", { ...input, language_code: "tl" }))
      .toHaveProperty("language_code", "fil");
  });
});
