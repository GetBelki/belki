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
  CitationUtmCoverageChart,
  CitationDomainCombobox,
  FanOutResponseStatusChart,
  FanOutSignalExplorer,
  OperatorFanOutTrendsPage,
  OperatorSourceDiscoveryPage,
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

describe("citation UTM coverage", () => {
  it("separates attribution coverage from citation volume", () => {
    render(
      <CitationUtmCoverageChart
        data={[
          {
            date: "2026-10-08",
            citations: 10,
            citationUrls: 8,
            utmSourceCitations: 6,
            coverage: 75,
          },
          {
            date: "2026-10-09",
            citations: 8,
            citationUrls: 8,
            utmSourceCitations: 2,
            coverage: 25,
          },
        ]}
        pending={false}
        source="chatgpt"
      />,
    );

    expect(screen.getByText("Citation UTM coverage")).toBeInTheDocument();
    expect(screen.getByText(/A drop signals citation-attribution risk, not fewer citations/))
      .toBeInTheDocument();
    expect(screen.getByLabelText(
      "Chart with reported ChatGPT attribution change marked for October 8 to 9, 2026",
    )).toBeInTheDocument();
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
  it("shows response outcomes against all completed responses", () => {
    render(
      <FanOutResponseStatusChart
        data={[{
          date: "2026-08-27",
          completedResponses: 207,
          reportedResponses: 5,
          unavailableResponses: 202,
          responsesWithFanOut: 5,
          totalFanOuts: 10,
          responseShare: 100,
          fanOutsPerResponse: 2,
          telemetryCoverage: 5 / 207 * 100,
        }]}
        pending={false}
      />,
    );

    expect(screen.getByText("Fan-out response status")).toBeInTheDocument();
    expect(screen.getByText("With fan-out")).toBeInTheDocument();
    expect(screen.getByText("Reported none")).toBeInTheDocument();
    expect(screen.getByText("Telemetry unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Responses with fan-out")).not.toBeInTheDocument();
  });

  it("toggles individual fan-out chart series from the legend", () => {
    render(
      <FanOutSignalExplorer
        activity={[{
          date: "2026-08-27",
          completedResponses: 10,
          reportedResponses: 10,
          unavailableResponses: 0,
          responsesWithFanOut: 8,
          totalFanOuts: 20,
          responseShare: 80,
          fanOutsPerResponse: 2,
          telemetryCoverage: 100,
        }]}
        group="direct-source"
        metric="shareOfFanOuts"
        onGroupChange={() => undefined}
        pending={false}
        signals={{
          site: [],
          official: [],
          government: [],
          education: [],
          pricing: [],
          reviews: [],
          best: [],
          top: [],
          comparison: [],
          vs: [],
        }}
        yearSignals={[]}
      />,
    );

    const official = screen.getByRole("button", { name: "Hide Official" });
    expect(official).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(official);
    expect(screen.getByRole("button", { name: "Show Official" }))
      .toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Show Official" }));
    expect(screen.getByRole("button", { name: "Hide Official" }))
      .toHaveAttribute("aria-pressed", "true");
  });

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
        activity: [{
          date: "2026-08-27",
          completedResponses: 6,
          reportedResponses: 5,
          unavailableResponses: 1,
          responsesWithFanOut: 5,
          totalFanOuts: 10,
          responseShare: 100,
          fanOutsPerResponse: 2,
          telemetryCoverage: 5 / 6 * 100,
        }],
        signals: {
          site: [],
          official: [],
          government: [],
          education: [],
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

    expect(await screen.findByText("Fan-out response status")).toBeInTheDocument();
    expect(await screen.findByText(/DataForSEO coverage change/))
      .toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "DataForSEO fan-out coverage details",
    })).toBeInTheDocument();
    expect(screen.getByText(/1 response is unavailable in this view/))
      .toBeInTheDocument();
    expect(screen.queryByText("Telemetry coverage")).not.toBeInTheDocument();

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

describe("source-discovery operator insights", () => {
  it("renders novelty, depth, site impact, and page-type evidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        period: "30d",
        source: "all",
        model: "all",
        models: [{ value: "gpt-5-6", label: "gpt-5-6", responses: 42 }],
        indexing: false,
        estimatedMinutes: 0,
        summary: {
          completedResponses: 42,
          retrievedUrlsPerResponse: 12.5,
          citedUrlsPerResponse: 4.25,
          newUrlShare: 27.6,
          newDomainShare: 5.2,
        },
        activity: [{
          date: "2026-08-28",
          completedResponses: 42,
          reportedFanOutResponses: 0,
          totalFanOuts: 0,
          retrievedUrls: 525,
          retrievedDomains: 80,
          citedUrls: 179,
          citedDomains: 60,
          fanOutsPerResponse: null,
          retrievedUrlsPerResponse: 12.5,
          citedUrlsPerResponse: 4.25,
          knownUrls: 67,
          newUrlsKnownDomains: 27,
          newUrlsNewDomains: 6,
          totalUniqueUrls: 100,
          knownUrlShare: 67,
          newUrlKnownDomainShare: 27,
          newUrlNewDomainShare: 6,
        }],
        pageTypes: [{
          type: "pdf",
          citations: 12,
          citationShare: 8,
          newUrlShare: 50,
          newDomainShare: 5,
        }],
        siteImpact: [{
          siteOperatorPresent: true,
          responses: 10,
          fanOutsPerResponse: 2,
          retrievedUrlsPerResponse: 15,
          citedUrlsPerResponse: 5,
          newUrlShare: 30,
          newDomainsPerResponse: 0.3,
        }],
      },
    }), { headers: { "content-type": "application/json" } }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/operator/insights/source-discovery"]}>
          <Routes>
            <Route
              path="/operator/insights/source-discovery"
              element={<OperatorSourceDiscoveryPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("PDF")).toBeInTheDocument();
    expect(screen.getByText("Citation novelty")).toBeInTheDocument();
    expect(screen.getByText("Retrieval depth")).toBeInTheDocument();
    expect(screen.getByText("Site-operator effect")).toBeInTheDocument();
    expect(screen.getByText("Cited page types")).toBeInTheDocument();
    expect(screen.getByText(/DataForSEO coverage change/))
      .toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "DataForSEO retrieval coverage details",
    })).toBeInTheDocument();
    expect(screen.getByText(/does not claim the underlying model/))
      .toBeInTheDocument();
  });
});
