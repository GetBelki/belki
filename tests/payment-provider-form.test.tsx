import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaymentProviderAccountForm } from "../src/app/components/payment-provider-form";
import type { PaymentProviderAccountInput } from "../src/shared/contracts";

function fillProviderMappings(
  container: HTMLElement,
  providerNoun: "Price ID" | "Product ID",
  values: Array<{ name: string; reference: string; amount: string }>,
) {
  const view = within(container);
  for (const value of values) {
    fireEvent.change(view.getByRole("textbox", { name: `${value.name} monthly ${providerNoun}` }), {
      target: { value: value.reference },
    });
    fireEvent.change(view.getByRole("textbox", { name: new RegExp(`^${value.name} monthly amount`) }), {
      target: { value: value.amount },
    });
  }
}

describe("payment provider setup form", () => {
  it("shows planned providers as disabled coming-soon options", () => {
    const { container } = render(
      <PaymentProviderAccountForm
        onSubmit={vi.fn()}
        pending={false}
        webhookEndpointKey="planned-provider-test"
        webhookUrl="https://app.example.com/api/webhooks/payments/planned-provider-test"
      />,
    );
    const view = within(container);

    fireEvent.click(view.getByRole("combobox", { name: "Payment provider" }));
    expect(screen.getByRole("option", { name: "Rebill — Coming soon" }))
      .toHaveAttribute("data-disabled");
    expect(screen.getByRole("option", { name: "Polar — Coming soon" }))
      .toHaveAttribute("data-disabled");
    fireEvent.click(screen.getByRole("option", { name: "Stripe" }));
    expect(view.getByText("Stripe secret key")).toBeInTheDocument();
  });

  it("shows the reserved webhook URL and submits the editable template catalogue", () => {
    const onSubmit = vi.fn<(input: PaymentProviderAccountInput) => void>();
    const endpointKey = "43e8c0e6-3a25-4aa2-85f3-d8c49d6f30c5";
    const webhookUrl = `https://app.example.com/api/webhooks/payments/${endpointKey}`;
    const { container } = render(
      <PaymentProviderAccountForm
        onSubmit={onSubmit}
        pending={false}
        webhookEndpointKey={endpointKey}
        webhookUrl={webhookUrl}
      />,
    );
    const view = within(container);

    expect(view.getByRole("textbox", { name: "Payment webhook endpoint URL" }))
      .toHaveValue(webhookUrl);
    fireEvent.change(container.querySelector('[name="label"]') as HTMLInputElement, {
      target: { value: "Platform Stripe account" },
    });
    fireEvent.change(container.querySelector('[name="secretKey"]') as HTMLInputElement, {
      target: { value: "sk_test_example_secret" },
    });
    fireEvent.change(container.querySelector('[name="webhookSecret"]') as HTMLInputElement, {
      target: { value: "whsec_example_secret" },
    });
    fireEvent.change(container.querySelector('[name="billingPortalConfigurationId"]') as HTMLInputElement, {
      target: { value: "bpc_example" },
    });
    fillProviderMappings(container, "Price ID", [
      { name: "Starter", reference: "price_starter", amount: "12.50" },
      { name: "Studio", reference: "price_studio", amount: "35.00" },
      { name: "Agency", reference: "price_agency", amount: "175.00" },
    ]);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      provider: "stripe",
      environment: "test",
      webhookEndpointKey: endpointKey,
      credentials: {
        secretKey: "sk_test_example_secret",
        webhookSecret: "whsec_example_secret",
      },
      currency: "EUR",
      catalogue: [
        { planId: "starter", externalReference: "price_starter", amountMinor: 1_250 },
        { planId: "studio", externalReference: "price_studio", amountMinor: 3_500 },
        { planId: "agency", externalReference: "price_agency", amountMinor: 17_500 },
      ],
    }));
    expect(onSubmit.mock.calls[0]?.[0].plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "starter", name: "Starter", sortOrder: 0 }),
      expect.objectContaining({ id: "studio", name: "Studio", sortOrder: 1 }),
      expect.objectContaining({ id: "agency", name: "Agency", sortOrder: 2 }),
    ]));
  });

  it("lets a fresh installation choose Dodo and rename its plans", () => {
    const onSubmit = vi.fn<(input: PaymentProviderAccountInput) => void>();
    const endpointKey = "43e8c0e6-3a25-4aa2-85f3-d8c49d6f30c5";
    const { container } = render(
      <PaymentProviderAccountForm
        onSubmit={onSubmit}
        pending={false}
        webhookEndpointKey={endpointKey}
        webhookUrl={`https://app.example.com/api/webhooks/payments/${endpointKey}`}
      />,
    );
    const view = within(container);

    fireEvent.click(view.getByRole("combobox", { name: "Payment provider" }));
    fireEvent.click(screen.getByRole("option", { name: "Dodo Payments" }));
    expect(view.getByText("Dodo Payments API key")).toBeInTheDocument();
    expect(view.queryByText("Billing action portal configuration ID")).not.toBeInTheDocument();
    fireEvent.change(view.getByRole("textbox", { name: "Billing currency" }), {
      target: { value: "brl" },
    });
    fireEvent.change(view.getByRole("textbox", { name: "Plan 1 ID" }), {
      target: { value: "latam_entry" },
    });
    fireEvent.change(view.getByRole("textbox", { name: "Plan 1 display name" }), {
      target: { value: "Latam Entry" },
    });
    fireEvent.click(view.getByRole("button", { name: "Remove Studio" }));
    fireEvent.click(view.getByRole("button", { name: "Remove Agency" }));
    fireEvent.change(container.querySelector('[name="label"]') as HTMLInputElement, {
      target: { value: "Dodo test account" },
    });
    fireEvent.change(container.querySelector('[name="apiKey"]') as HTMLInputElement, {
      target: { value: "dodo_test_example_secret" },
    });
    fireEvent.change(container.querySelector('[name="webhookSecret"]') as HTMLInputElement, {
      target: { value: "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" },
    });
    fillProviderMappings(container, "Product ID", [
      { name: "Latam Entry", reference: "pdt_entry", amount: "49.90" },
    ]);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      provider: "dodo",
      label: "Dodo test account",
      currency: "BRL",
      catalogue: [
        { planId: "latam_entry", externalReference: "pdt_entry", amountMinor: 4_990 },
      ],
      configuration: {},
    }));
    expect(onSubmit.mock.calls[0]?.[0].plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "latam_entry", name: "Latam Entry", sortOrder: 0 }),
    ]));
    expect(onSubmit.mock.calls[0]?.[0].plans).toHaveLength(1);
  });
});
