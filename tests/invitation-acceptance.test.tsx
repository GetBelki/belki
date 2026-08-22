import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AcceptInvitePage } from "../src/app/pages/auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(valid: boolean) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ data: { valid } }),
    { headers: { "content-type": "application/json" }, status: 200 },
  )));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/accept-invite?token=${"a".repeat(32)}`]}>
        <AcceptInvitePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("invitation acceptance", () => {
  it("shows an unavailable notice instead of the form for an invalid invitation", async () => {
    renderPage(false);

    expect(await screen.findByRole("heading", { name: "Invitation unavailable" }))
      .toBeInTheDocument();
    expect(screen.getByText(/ask the workspace owner/iu)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" }))
      .not.toBeInTheDocument();
  });

  it("shows the acceptance form only after validating the invitation", async () => {
    renderPage(true);

    expect(await screen.findByRole("button", { name: "Accept invitation" }))
      .toBeInTheDocument();
    expect(screen.getByText("Your name")).toBeInTheDocument();
  });
});
