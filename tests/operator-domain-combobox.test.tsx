import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { insightNumericYAxisMax, insightYAxisMax } from "../src/app/lib/chart-scale";
import {
  fanOutMetricValue,
  fanOutSignalGroupValue,
} from "../src/app/lib/operator-fanout";
import {
  CitationDomainCombobox,
  OperatorFanOutTrendsPage,
} from "../src/app/pages/operator-insights";

class ResizeObserverMock {
  disconnect() {}
  observe() {}
  unobserve() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("citation domain combobox", () => {
  it("searches inside the popup and applies a domain immediately", async () => {
    const options = [
      { label: "All cited domains", value: "" },
      { label: "reddit.com", value: "reddit.com" },
      { label: "example.com", value: "example.com" },
    ];
    const onSearchChange = vi.fn();
    const onValueChange = vi.fn();

    render(
      <CitationDomainCombobox
        isFetching={false}
        onSearchChange={onSearchChange}
        onValueChange={onValueChange}
        options={options}
        searchValue=""
        value={options[0]!}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Cited domain" }));
    const search = await screen.findByRole("combobox", {
      name: "Search cited domains",
    });
    fireEvent.change(search, { target: { value: "redd" } });

    expect(onSearchChange).toHaveBeenLastCalledWith("redd");
    fireEvent.click(await screen.findByRole("option", { name: "reddit.com" }));
    expect(onValueChange).toHaveBeenCalledWith(
      options[1],
      expect.any(Object),
    );
  });
});

describe("operator insight chart scale", () => {
  it("adds useful headroom while preserving the zero baseline", () => {
    expect(insightYAxisMax([0.1, 0.4])).toBe(1);
    expect(insightYAxisMax([1.2, 3.9])).toBe(5);
    expect(insightYAxisMax([4, 9.8])).toBe(15);
    expect(insightYAxisMax([25])).toBe(30);
    expect(insightYAxisMax([42])).toBe(50);
    expect(insightYAxisMax([100])).toBe(100);
  });

  it("scales count metrics without a percentage ceiling", () => {
    expect(insightNumericYAxisMax([])).toBe(1);
    expect(insightNumericYAxisMax([0.4])).toBe(0.5);
    expect(insightNumericYAxisMax([2.1, 3.9])).toBe(5);
    expect(insightNumericYAxisMax([120])).toBe(200);
  });
});

describe("fan-out operator filters", () => {
  it("defaults invalid values and accepts every supported metric and group", () => {
    expect(fanOutMetricValue(null)).toBe("shareOfFanOuts");
    expect(fanOutMetricValue("fanOutsPerResponse")).toBe("fanOutsPerResponse");
    expect(fanOutMetricValue("responseShare")).toBe("responseShare");
    expect(fanOutSignalGroupValue(null)).toBe("direct-source");
    expect(fanOutSignalGroupValue("commercial-research")).toBe("commercial-research");
    expect(fanOutSignalGroupValue("listicle")).toBe("listicle");
    expect(fanOutSignalGroupValue("comparison")).toBe("comparison");
    expect(fanOutSignalGroupValue("years")).toBe("years");
  });

  it("persists metric and signal-group selections in the URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        period: "30d",
        source: "chatgpt",
        model: "all",
        models: [
          { value: "gpt-5-6", label: "gpt-5-6", responses: 42 },
          { value: "__unreported__", label: "Model not reported", responses: 5 },
        ],
        indexing: false,
        remainingSnapshots: 0,
        estimatedMinutes: 0,
        activity: [],
        signals: {
          site: [],
          official: [],
          government: [],
          pricing: [],
          reviews: [],
          best: [],
          top: [],
          comparison: [],
          vs: [],
        },
        yearSignals: [],
        total: [],
        siteOperator: [],
        reviews: [],
        official: [],
        government: [],
        years: [],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function LocationProbe() {
      return <output aria-label="Current search">{useLocation().search}</output>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/operator/insights/fan-out"]}>
          <Routes>
            <Route
              path="/operator/insights/fan-out"
              element={<><OperatorFanOutTrendsPage /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Fan-out metric" }));
    fireEvent.click(await screen.findByRole("option", { name: "Per response" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Current search")).toHaveTextContent(
        "?metric=fanOutsPerResponse",
      );
    });

    const group = await screen.findByRole("combobox", {
      name: "Fan-out signal group",
    });
    fireEvent.click(group);
    const listbox = await screen.findByRole("listbox");
    fireEvent.click(within(listbox).getByRole("option", { name: "Comparison" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Current search")).toHaveTextContent(
        "metric=fanOutsPerResponse&group=comparison",
      );
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Fan-out model" }));
    fireEvent.click(await screen.findByRole("option", { name: "gpt-5-6 (42)" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Current search")).toHaveTextContent(
        "metric=fanOutsPerResponse&group=comparison&model=gpt-5-6",
      );
    });
  });
});
