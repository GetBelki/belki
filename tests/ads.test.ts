import { describe, expect, it } from "vitest";
import {
  allowedAdAssetUrl,
  decodeAdKey,
  normalizeAdItem,
} from "../src/worker/lib/ads";
import { parseAdvancedPayload } from "../src/worker/ingestion/dataforseo-schema";

const ad = {
  type: "chat_gpt_ad",
  rank_group: 1,
  rank_absolute: 4,
  title: "Create Online Payment Form",
  snippet: "Create online payment forms and receive payments instantly.",
  url: "https://www.jotform.com/online-payments/?utm_source=chatgptads&utm_medium=cpc&adgroup=0519e1",
  domain: "www.jotform.com",
  image_url: "https://bzrcdn.openai.com/tessera/example.webp",
  advertiser: {
    name: "Jotform",
    url: "https://www.jotform.com/",
    favicon_url: "https://api.dataforseo.com/cdn/i/example:0",
  },
};

describe("ChatGPT ad normalization", () => {
  it("normalizes advertiser and creative identities and removes tracking parameters", () => {
    const normalized = normalizeAdItem(ad);

    expect(normalized).not.toBeNull();
    expect(normalized?.advertiserIdentity).toBe("domain:jotform.com");
    expect(normalized?.canonicalUrl).toBe("https://www.jotform.com/online-payments");
    expect(normalized?.rankAbsolute).toBe(4);
    expect(decodeAdKey(normalized!.advertiserKey)).toBe("domain:jotform.com");
  });

  it("accepts provider JSON containing escaped slashes", () => {
    const escaped = JSON.parse(String.raw`{
      "type":"chat_gpt_ad",
      "rank_group":1,
      "rank_absolute":4,
      "title":"Rent Cameras + Lenses from ShareGrid",
      "snippet":"Join the camera sharing community!",
      "url":"https:\/\/www.sharegrid.com\/",
      "domain":"www.sharegrid.com",
      "image_url":"https:\/\/bzrcdn.openai.com\/tessera\/creative.webp",
      "advertiser":{
        "name":"ShareGrid Platforms, LLC",
        "url":"https:\/\/www.sharegrid.com\/",
        "favicon_url":"https:\/\/api.dataforseo.com\/cdn\/i\/asset:0"
      }
    }`) as unknown;
    const payload = parseAdvancedPayload({
      tasks: [{
        result: [{
          keyword: "camera rental",
          location_code: 2840,
          language_code: "en",
          items: [escaped],
        }],
      }],
    });
    const parsed = payload.tasks[0]!.result![0]!.items[0]!;
    const normalized = normalizeAdItem(parsed);

    expect(parsed.url).toBe("https://www.sharegrid.com/");
    expect(normalized?.advertiserDomain).toBe("sharegrid.com");
    expect(normalized?.imageSourceUrl).toBe(
      "https://bzrcdn.openai.com/tessera/creative.webp",
    );
  });

  it("only permits the known HTTPS asset hosts", () => {
    expect(allowedAdAssetUrl("https://bzrcdn.openai.com/tessera/a.webp")?.hostname)
      .toBe("bzrcdn.openai.com");
    expect(allowedAdAssetUrl("https://api.dataforseo.com/cdn/i/a")?.hostname)
      .toBe("api.dataforseo.com");
    expect(allowedAdAssetUrl("http://bzrcdn.openai.com/a.webp")).toBeNull();
    expect(allowedAdAssetUrl("https://example.com/a.webp")).toBeNull();
  });
});
