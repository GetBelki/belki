import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OperatorProvidersPage from "../src/app/pages/operator-providers";

const apiMocks = vi.hoisted(() => ({
  api: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../src/app/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/app/lib/api")>(),
  api: apiMocks.api,
  patch: apiMocks.patch,
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
  cleanup();
  apiMocks.api.mockReset();
  apiMocks.patch.mockReset();
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
    expect(screen.getByRole("status")).toHaveTextContent("Checking DataForSEO credentials…");

    await act(async () => {
      resolveTest?.({
        id: account.id,
        status: "passed",
        message: "DataForSEO credentials verified.",
      });
      await Promise.resolve();
    });

    const result = (await screen.findByText("Verified")).closest("[role='status']");
    expect(result).not.toBeNull();
    expect(result).toHaveClass("provider-test-feedback-passed");
    expect(result).toHaveTextContent("Verified");
    expect(result).toHaveTextContent("DataForSEO credentials verified.");
    expect(result?.parentElement).toHaveClass("provider-account-actions");
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
    expect(result).toHaveTextContent("DataForSEO rejected these credentials.");
  });
});

describe("operator provider account names", () => {
  it("renames an account from the actions menu and confirms the saved name", async () => {
    apiMocks.api.mockResolvedValue(configuration);
    apiMocks.patch.mockResolvedValue({ id: account.id, label: "Primary search account" });
    renderPage();

    fireEvent.keyDown(await screen.findByRole("button", {
      name: `More actions for ${account.label}`,
    }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const nameInput = screen.getByRole("textbox", { name: "Account name" });
    expect(nameInput).toHaveValue(account.label);
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: "Primary search account" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledWith(
      "/operator/providers/dataforseo%3Aplatform%3Av1",
      { label: "Primary search account" },
    ));
    const notice = (await screen.findByText("Account renamed")).closest("[role='status']");
    expect(notice).toHaveTextContent("The account is now named Primary search account.");
  });
});

describe("operator provider activity", () => {
  it("explains failed and uncertain requests separately from in-progress work", async () => {
    const metrics = {
      attempts: 13,
      submitted: 13,
      completed: 7,
      failed: 3,
      ambiguous: 2,
      needsAttention: 5,
      inProgress: 1,
      successRate: 58.3,
      averageLatencyMs: 60_000,
      lastActivityAt: null,
    };
    apiMocks.api.mockResolvedValue({
      ...configuration,
      routes: [{
        trackingSource: "chatgpt",
        enabled: true,
        providerAccountId: null,
        effectiveProviderAccountId: account.id,
      }],
      activity: {
        period: "30d",
        range: { from: "2026-08-02", to: "2026-09-01" },
        summary: metrics,
        byAccount: [{
          ...metrics,
          providerAccountId: account.id,
          provider: account.provider,
        }],
        byPlatform: [{ ...metrics, trackingSource: "chatgpt" }],
      },
    });
    renderPage();

    await waitFor(() => expect(screen.getAllByText("Failed / uncertain")).toHaveLength(2));
    expect(screen.getAllByText("Completion rate")).toHaveLength(2);
    expect(screen.getByText(
      "3 failed · 2 uncertain · 1.0 min average · No activity in the last 30 days",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "7 completed · 3 failed · 2 uncertain · 1 in progress",
    )).toBeInTheDocument();
    expect(screen.getAllByText("58.3%")).toHaveLength(2);
    expect(screen.queryByText(/needs? attention|attention$/iu)).not.toBeInTheDocument();
  });
});
