import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TrendChartLegend } from "../src/app/components/trend-chart";
import {
  chartDateLabel,
  mobileHiddenTrendSeries,
  percentageChartScale,
  previousTrendValue,
  toggleTrendSeries,
  trendWindowSummary,
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
