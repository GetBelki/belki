import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OperatorProvidersPage from "../src/app/pages/operator-providers";

const apiMocks = vi.hoisted(() => ({
  api: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../src/app/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/app/lib/api")>(),
  api: apiMocks.api,
  post: apiMocks.post,
}));

const account = {
  id: "dataforseo:platform:v1",
  provider: "dataforseo",
  providerLabel: "DataForSEO",
  label: "Platform DataForSEO account",
  status: "active",
  credentialSource: "environment",
  credentialConfigured: true,
  credentialVersion: null,
  isDefault: true,
  priority: 100,
  supportedSources: ["chatgpt"],
  adapterVersion: "v1",
  lastTestStatus: null,
  lastTestedAt: null,
  lastTestMessage: null,
};

const configuration = {
  accounts: [account],
  routes: [],
  activity: {
    period: "30d",
    range: { from: "2026-07-30", to: "2026-08-29" },
    summary: {
      attempts: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      ambiguous: 0,
      needsAttention: 0,
      inProgress: 0,
      successRate: 0,
      averageLatencyMs: null,
      lastActivityAt: null,
    },
    byAccount: [],
    byPlatform: [],
  },
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <OperatorProvidersPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  apiMocks.api.mockReset();
  apiMocks.post.mockReset();
});

describe("operator provider credential tests", () => {
  it("shows progress and a clear accessible success result", async () => {
    let resolveTest: ((value: unknown) => void) | undefined;
    apiMocks.api.mockResolvedValue(configuration);
    apiMocks.post.mockImplementation(() => new Promise((resolve) => {
      resolveTest = resolve;
    }));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect(await screen.findByRole("button", { name: "Testing…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Testing connection");
    expect(screen.getByRole("status")).toHaveTextContent("Checking DataForSEO credentials…");

    await act(async () => {
      resolveTest?.({
        id: account.id,
        status: "passed",
        message: "DataForSEO credentials verified.",
      });
      await Promise.resolve();
    });

    const result = await screen.findByRole("status");
    expect(result).toHaveClass("provider-test-feedback-passed");
    expect(result).toHaveTextContent("Connection verified");
    expect(result).toHaveTextContent("DataForSEO credentials verified.");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/operator/providers/dataforseo%3Aplatform%3Av1/test",
    );
  });

  it("announces a failed provider response as an alert", async () => {
    apiMocks.api.mockResolvedValue(configuration);
    apiMocks.post.mockResolvedValue({
      id: account.id,
      status: "failed",
      message: "DataForSEO rejected these credentials.",
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    const result = await screen.findByRole("alert");
    expect(result).toHaveClass("provider-test-feedback-failed");
    expect(result).toHaveTextContent("Connection test failed");
    expect(result).toHaveTextContent("DataForSEO rejected these credentials.");
  });
});
