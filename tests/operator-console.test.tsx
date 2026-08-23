import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operatorLimitUsage,
  operatorPlanLabel,
  operatorStatusLabel,
} from "../src/app/lib/operator-console";
import OperatorPage from "../src/app/pages/operator";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator console formatting", () => {
  it("turns implementation values into professional operator copy", () => {
    expect(operatorPlanLabel("self_hosted")).toBe("Internal");
    expect(operatorPlanLabel("agency_plus")).toBe("Agency Plus");
    expect(operatorLimitUsage(5, 1_000_000)).toBe("Unlimited");
    expect(operatorLimitUsage(12, 75)).toBe("12/75");
    expect(operatorStatusLabel("pending_payment")).toBe("Pending Payment");
  });
});

describe("operator console presentation", () => {
  it("shows a flat operations summary and moves status changes behind Manage", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const data = url.includes("/operator/workspaces")
        ? [{
            id: "workspace-1",
            name: "Torito IO",
            status: "active",
            plan_key: "self_hosted",
            subscription_status: "active",
            monthly_units: 0,
            project_limit: 1_000_000,
            prompt_limit: 1_000_000,
            source_limit: 4,
            seats: 2,
            projects: 5,
            prompts: 207,
            stripe_livemode: null,
          }]
        : [];
      return Promise.resolve(new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OperatorPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", {
      name: "Platform operations",
    })).toBeInTheDocument();
    expect(await screen.findByText("Internal")).toBeInTheDocument();
    expect(screen.getAllByText("Unlimited")).toHaveLength(2);
    expect(screen.queryByText("self_hosted")).not.toBeInTheDocument();
    expect(screen.queryByText(/1000000/u)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create invitation" })).toHaveLength(1);
    expect(container.querySelector(".operator-status-dot")).not.toBeInTheDocument();
    expect(container.querySelector(".operator-status-active")).toHaveTextContent("Active");

    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByRole("dialog")).toHaveClass("operator-invite-dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Manage Torito IO" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Manage Torito IO",
    );
    expect(screen.getByRole("button", { name: "No changes" })).toBeDisabled();
  });
});
