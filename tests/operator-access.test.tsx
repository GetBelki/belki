import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorNavigation } from "../src/app/components/layout";
import { OperatorDataFailure } from "../src/app/components/operator-access";
import { ApiClientError } from "../src/app/lib/api";
import { isOperatorAuthenticationFailure } from "../src/app/lib/operator-access";
import { OperatorFanOutTrendsPage } from "../src/app/pages/operator-insights";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator navigation", () => {
  it("uses document links so Cloudflare Access can challenge the request", () => {
    render(<OperatorNavigation pathname="/operator/insights/citations" />);

    expect(screen.getByRole("link", { name: "Console" })).toHaveAttribute(
      "href",
      "/operator",
    );
    expect(screen.getByRole("link", { name: "Citation trends" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Fan-out trends" })).toHaveAttribute(
      "href",
      "/operator/insights/fan-out",
    );
  });
});

describe("operator access failures", () => {
  it("recognizes Access responses that could not be parsed as API JSON", () => {
    expect(isOperatorAuthenticationFailure(
      new ApiClientError("Request failed (200)", 200, "request_failed"),
    )).toBe(true);
    expect(isOperatorAuthenticationFailure(
      new ApiClientError("Internal error", 500, "internal_error"),
    )).toBe(false);
  });

  it("offers a document login and a retry without showing an empty state", () => {
    const onRetry = vi.fn();
    render(
      <MemoryRouter initialEntries={["/operator/insights/citations?period=90d"]}>
        <OperatorDataFailure
          error={new ApiClientError(
            "Request failed (200)",
            200,
            "request_failed",
          )}
          onRetry={onRetry}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", {
      name: "Operator authentication required",
    })).toBeInTheDocument();
    expect(screen.getByRole("link", {
      name: "Continue to secure login",
    })).toHaveAttribute(
      "href",
      "/operator/insights/citations?period=90d",
    );
    expect(screen.queryByText("No trend data")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not translate an Access HTML response into empty chart data", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      "<html><title>Cloudflare Access</title></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ))));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/operator/insights/fan-out"]}>
          <Routes>
            <Route
              path="/operator/insights/fan-out"
              element={<OperatorFanOutTrendsPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", {
      name: "Operator authentication required",
    })).toBeInTheDocument();
    expect(screen.queryByText("No fan-out activity")).not.toBeInTheDocument();
  });
});
