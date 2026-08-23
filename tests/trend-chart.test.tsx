import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TrendChartLegend } from "../src/app/components/trend-chart";
import {
  chartDateLabel,
  mobileHiddenTrendSeries,
  percentageChartScale,
  rankChartScale,
  previousTrendValue,
  toggleTrendSeries,
  trendWindowSummary,
  weightedTrendWindowSummary,
} from "../src/app/lib/trend-chart";

describe("trend chart dates", () => {
  it("formats chart dates and safely ignores unsupported tooltip labels", () => {
    expect(chartDateLabel("2026-08-22")).not.toBe("2026-08-22");
    expect(chartDateLabel({ date: "2026-08-22" })).toBe("");
  });
});

describe("trend chart scales", () => {
  it("uses the available vertical space without clipping percentage values", () => {
    expect(percentageChartScale([
      { metric_date: "2026-08-21", source: 28 },
      { metric_date: "2026-08-22", source: 35 },
    ], ["source"])).toEqual({
      domain: [0, 40],
      ticks: [0, 10, 20, 30, 40],
    });
    expect(percentageChartScale([
      { metric_date: "2026-08-22", competitor: 64 },
    ], ["competitor"]).domain).toEqual([0, 75]);
  });

  it("keeps zero and the full percentage range safe", () => {
    expect(percentageChartScale([], ["source"]).domain).toEqual([0, 10]);
    expect(percentageChartScale([
      { metric_date: "2026-08-22", source: 100 },
    ], ["source"]).domain).toEqual([0, 100]);
  });

  it("builds an integer rank scale that can be reversed by the chart", () => {
    expect(rankChartScale([
      { metric_date: "2026-08-21", owned: 1.4 },
      { metric_date: "2026-08-22", owned: 3.2 },
    ], ["owned"])).toEqual({
      domain: [1, 4],
      ticks: [1, 2, 3, 4],
    });
    expect(rankChartScale([
      { metric_date: "2026-08-22", owned: 1 },
    ], ["owned"])).toEqual({
      domain: [1, 2],
      ticks: [1, 2],
    });
  });
});

describe("trend summaries", () => {
  const points = Array.from({ length: 14 }, (_, index) => ({
    metric_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    owned: index + 1,
  }));

  it("compares the latest seven values with the previous seven", () => {
    expect(trendWindowSummary(points, "owned")).toEqual({
      value: 11,
      change: 7,
    });
  });

  it("does not invent a comparison before both windows exist", () => {
    expect(trendWindowSummary(points.slice(0, 5), "owned")).toEqual({
      value: 3,
      change: null,
    });
  });

  it("finds the previous recorded value for tooltip deltas", () => {
    expect(previousTrendValue(points, "2026-08-08", "owned")).toBe(7);
    expect(previousTrendValue(points, "2026-08-01", "owned")).toBeNull();
  });

  it("weights average position by ranked responses", () => {
    expect(weightedTrendWindowSummary([
      { metric_date: "2026-08-21", owned: 1, ownedSamples: 1 },
      { metric_date: "2026-08-22", owned: 3, ownedSamples: 3 },
    ], "owned", "ownedSamples")).toEqual({
      value: 2.5,
      change: null,
    });
  });

  it("keeps missing rank samples inside their calendar window", () => {
    const positionPoints = Array.from({ length: 14 }, (_, index) => ({
      metric_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      owned: index === 0 ? 5 : index === 7 ? null : index < 7 ? 3 : 1,
      ownedSamples: index === 7 ? 0 : 1,
    }));
    expect(weightedTrendWindowSummary(
      positionPoints,
      "owned",
      "ownedSamples",
    )).toEqual({
      value: 1,
      change: -16 / 7,
    });
  });
});

describe("trend series visibility", () => {
  const keys = ["owned", "one", "two"];

  it("toggles series but always leaves one visible", () => {
    const first = toggleTrendSeries(new Set(), "owned", keys);
    const second = toggleTrendSeries(first, "one", keys);
    const third = toggleTrendSeries(second, "two", keys);
    expect([...second]).toEqual(["owned", "one"]);
    expect([...third]).toEqual(["owned", "one"]);
    expect([...toggleTrendSeries(second, "owned", keys)]).toEqual(["one"]);
  });

  it("keeps the primary series and two comparisons visible on mobile", () => {
    expect([...mobileHiddenTrendSeries([
      { key: "one" },
      { key: "two" },
      { key: "three" },
      { key: "owned", primary: true },
      { key: "four" },
    ])]).toEqual(["three", "four"]);
  });

  it("shows only two comparisons when no primary series is present", () => {
    expect([...mobileHiddenTrendSeries([
      { key: "one" },
      { key: "two" },
      { key: "three" },
    ])]).toEqual(["three"]);
  });
});

describe("trend chart legend", () => {
  it("exposes series visibility and detail navigation accessibly", () => {
    const onToggle = vi.fn();
    render(
      <MemoryRouter>
        <TrendChartLegend
          highlightedKey={null}
          hiddenKeys={new Set(["competitor"])}
          items={[
            { key: "owned", label: "Belki", color: "#18181b", badge: "Your brand" },
            { key: "competitor", label: "Competitor", color: "#2563eb", detailHref: "/citations/competitor.test" },
          ]}
          onHighlightedKeyChange={() => undefined}
          onToggle={onToggle}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Hide Belki" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Show Competitor" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: "Open Competitor details" })).toHaveAttribute("href", "/citations/competitor.test");
    fireEvent.click(screen.getByRole("button", { name: "Show Competitor" }));
    expect(onToggle).toHaveBeenCalledWith("competitor");
  });
});
