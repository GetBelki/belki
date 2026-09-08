import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TrackingSourceMark } from "../src/app/components/tracking-source-mark";
import { TRACKING_SOURCES } from "../src/shared/tracking-sources";

afterEach(cleanup);

describe("tracking platform marks", () => {
  it.each(TRACKING_SOURCES.filter((source) => source !== "perplexity" && source !== "copilot"))("renders a decorative SVG for %s", (source) => {
    const { container } = render(<TrackingSourceMark source={source} />);
    const mark = container.querySelector("svg");

    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark?.querySelector("path, circle")).not.toBeNull();
  });

  it.each(["perplexity", "copilot"] as const)("renders a decorative platform favicon for %s", (source) => {
    const { container } = render(<TrackingSourceMark source={source} />);
    expect(container.querySelector(".domain-favicon")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    expect(container.querySelector("img")?.getAttribute("src")).toContain(source === "perplexity" ? "perplexity.ai" : "copilot.microsoft.com");
  });

  it("uses distinct gradient definitions for multiple Gemini-family marks", () => {
    const { container } = render(
      <>
        <TrackingSourceMark source="gemini" />
        <TrackingSourceMark source="google_ai_overview" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("linearGradient"), (gradient) => gradient.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
