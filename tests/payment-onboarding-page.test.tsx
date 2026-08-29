import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../src/app/context";
import type { Session } from "../src/app/lib/api";
import { OPERATOR_PAYMENT_ONBOARDING_PATH } from "../src/app/lib/onboarding-navigation";
import PaymentOnboardingPage from "../src/app/pages/payment-onboarding";

const apiMocks = vi.hoisted(() => ({
  api: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../src/app/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/app/lib/api")>(),
  api: apiMocks.api,
  post: apiMocks.post,
}));

const operatorSession: Session = {
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    role: "owner",
  },
  workspaceId: "workspace-1",
  workspace: {
    id: "workspace-1",
    name: "Workspace",
    publicBaseUrl: "https://app.example.com",
    status: "active",
    plan_key: "self_hosted",
  },
  workspaces: [],
  projects: [],
  isPlatformOperator: true,
  capabilities: {
    emailDelivery: false,
    publicOriginManaged: true,
  },
};

afterEach(() => {
  apiMocks.api.mockReset();
  apiMocks.post.mockReset();
});

describe("payment onboarding", () => {
  it("keeps self-hosted feedback spaced with the mode cards and recovers Operator access", async () => {
    apiMocks.api.mockImplementation((path: string) => {
      if (path === "/operator/payment-providers") {
        return Promise.resolve({
          mode: "undecided",
          required: true,
          legacyImportAvailable: false,
          plans: [],
          accounts: [],
        });
      }
      if (path === "/projects") return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    apiMocks.post.mockRejectedValue(new TypeError("Failed to fetch"));
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[OPERATOR_PAYMENT_ONBOARDING_PATH]}>
          <AppProvider session={operatorSession}>
            <PaymentOnboardingPage />
          </AppProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Continue without payments" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Operator authentication expired");
    expect(alert).not.toHaveTextContent("Failed to fetch");
    expect(container.querySelector(".payment-mode-selection")).toContainElement(alert);
    expect(screen.getByRole("link", { name: "Renew secure login" })).toHaveAttribute(
      "href",
      OPERATOR_PAYMENT_ONBOARDING_PATH,
    );
    expect(apiMocks.post).toHaveBeenCalledWith("/operator/payment-providers/self-hosted");
  });
});
