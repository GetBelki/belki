import { describe, expect, it } from "vitest";
import { dataForSeoTask } from "../src/worker/lib/dataforseo";

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
});
