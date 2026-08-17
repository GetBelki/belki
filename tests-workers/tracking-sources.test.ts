import { describe, expect, it } from "vitest";
import { TRACKING_SOURCES } from "../src/shared/tracking-sources";
import { PLAN_ENTITLEMENTS } from "../src/worker/lib/usage";
import {
  availableSources,
  planSourceEntitlement,
} from "../src/worker/lib/tracking-sources";

function featureEnv(flags: Partial<Record<string, string>> = {}): Env {
  return {
    TRACKING_SOURCE_GEMINI_ENABLED: "false",
    TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED: "false",
    TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED: "false",
    ...flags,
  } as unknown as Env;
}

describe("tracking source entitlements", () => {
  it("keeps optional managed sources behind independent feature flags", () => {
    expect(availableSources(featureEnv())).toEqual(["chatgpt"]);
    expect(availableSources(featureEnv({ TRACKING_SOURCE_GEMINI_ENABLED: "true" })))
      .toEqual(["chatgpt", "gemini"]);
    expect(availableSources(featureEnv({
      TRACKING_SOURCE_GEMINI_ENABLED: "true",
      TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED: "true",
      TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED: "true",
    }))).toEqual(TRACKING_SOURCES);
  });

  it("matches the public prompt, project, and source limits", () => {
    expect(PLAN_ENTITLEMENTS.starter).toMatchObject({
      promptLimit: 25,
      projectLimit: 1,
      sourceLimit: 1,
    });
    expect(PLAN_ENTITLEMENTS.studio).toMatchObject({
      promptLimit: 75,
      projectLimit: 5,
      sourceLimit: 2,
    });
    expect(PLAN_ENTITLEMENTS.agency).toMatchObject({
      promptLimit: 250,
      projectLimit: 30,
      sourceLimit: 4,
    });
    expect(planSourceEntitlement("starter")).toEqual({
      allowedSources: ["chatgpt"],
      sourceLimit: 1,
    });
    expect(planSourceEntitlement("studio")).toEqual({
      allowedSources: [...TRACKING_SOURCES],
      sourceLimit: 2,
    });
  });
});
