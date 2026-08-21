import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("entity extraction benchmark", () => {
  it("treats human-labelled competitors as valid auto-track targets by default", () => {
    const directory = mkdtempSync(join(tmpdir(), "entity-benchmark-"));
    const goldPath = join(directory, "gold.jsonl");
    const predictionPath = join(directory, "v2.jsonl");
    writeFileSync(goldPath, `${JSON.stringify({
      id: "answer-1",
      languageCode: "en",
      entities: [{
        surface: "Contoso",
        canonicalName: "Contoso",
        entityType: "brand",
        relationship: "competitor",
      }],
    })}\n`);
    writeFileSync(predictionPath, `${JSON.stringify({
      id: "answer-1",
      entities: [{
        surface: "Contoso",
        canonicalName: "Contoso",
        entityType: "brand",
        relationship: "competitor",
        autoTrackEligible: true,
      }],
    })}\n`);

    const output = execFileSync(process.execPath, [
      resolve("scripts/entity-extraction-benchmark.mjs"),
      "--gold",
      goldPath,
      "--prediction",
      `v2=${predictionPath}`,
    ], { encoding: "utf8" });
    const report = JSON.parse(output) as {
      v2: { autoTrack: { precision: number } };
    };

    expect(report.v2.autoTrack.precision).toBe(1);
  });
});
