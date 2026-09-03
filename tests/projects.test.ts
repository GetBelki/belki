import { describe, expect, it } from "vitest";
import {
  projectSummariesFromRows,
  type ProjectSourceCountRow,
  type ProjectSummaryRow,
} from "../src/worker/lib/projects";

const project: ProjectSummaryRow = {
  id: "project-1",
  name: "Canon",
  primary_domain: "canon.com",
  html_capture_enabled: 0,
  paused_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-20T00:00:00.000Z",
  query_count: 17,
  last_snapshot_at: "2026-08-20T09:11:00.000Z",
  ads_count: 2,
  products_count: 9,
};

describe("project summaries", () => {
  it("maps per-source counts into the existing session response shape", () => {
    const sourceCounts: ProjectSourceCountRow[] = [
      {
        project_id: project.id,
        tracking_source: "chatgpt",
        ads_count: 2,
        products_count: 7,
      },
      {
        project_id: project.id,
        tracking_source: "google_ai_mode",
        ads_count: 0,
        products_count: 2,
      },
    ];

    expect(projectSummariesFromRows([project], sourceCounts)).toEqual([
      {
        ...project,
        source_data_counts: {
          chatgpt: { ads: 2, products: 7 },
          google_ai_mode: { ads: 0, products: 2 },
        },
      },
    ]);
  });

  it("keeps projects without source facts in the result", () => {
    expect(projectSummariesFromRows([project], [])).toEqual([
      { ...project, source_data_counts: {} },
    ]);
  });
});
