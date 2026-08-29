import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  PaymentProviderAccountInputSchema,
  PaymentProviderAccountUpdateSchema,
  PaymentProviderCatalogueUpdateSchema,
  PaymentProviderCredentialInputSchema,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { writeAudit } from "../lib/audit";
import { assertOperator } from "../lib/auth";
import {
  createPaymentProviderAccount,
  importLegacyStripePaymentAccount,
  loadPaymentProviderAccount,
  paymentProviderConfiguration,
  recordPaymentProviderTest,
  replacePaymentProviderCatalogue,
  replacePaymentProviderCredential,
  selectSelfHostedPaymentMode,
  setDefaultPaymentProviderAccount,
  updatePaymentProviderAccount,
} from "../payments/accounts";
import { paymentProviderAdapter } from "../payments/registry";

const PaymentAccountParamSchema = z.object({ id: z.string().trim().min(1).max(200) });

export const paymentProviderRoutes = new Hono<AppEnv>();

paymentProviderRoutes.get("/operator/payment-providers", async (c) => {
  await assertOperator(c);
  return c.json({ data: await paymentProviderConfiguration(c.env) });
});

paymentProviderRoutes.post(
  "/operator/payment-providers",
  zValidator("json", PaymentProviderAccountInputSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const account = await createPaymentProviderAccount(
      c.env,
      c.req.valid("json"),
      principal.userId,
    );
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.payment_provider.created",
      resourceType: "payment_provider_account",
      resourceId: account.id,
      metadata: {
        provider: account.provider,
        environment: account.environment,
        isDefault: account.isDefault,
      },
    });
    return c.json({ data: account }, 201);
  },
);

paymentProviderRoutes.post("/operator/payment-providers/import-stripe", async (c) => {
  await assertOperator(c);
  const principal = c.get("principal");
  const result = await importLegacyStripePaymentAccount(c.env, principal.userId);
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: "operator.payment_provider.legacy_imported",
    resourceType: "payment_provider_account",
    resourceId: result.id,
    metadata: { provider: "stripe", credentialVersion: result.credentialVersion },
  });
  return c.json({ data: result });
});

paymentProviderRoutes.post("/operator/payment-providers/self-hosted", async (c) => {
  await assertOperator(c);
  const principal = c.get("principal");
  await selectSelfHostedPaymentMode(c.env, principal.userId);
  await writeAudit(c.env.CONTROL_DB, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: "operator.payment_mode.self_hosted",
    resourceType: "payment_configuration",
    resourceId: "installation",
  });
  return c.json({ data: { mode: "self_hosted" } });
});

paymentProviderRoutes.patch(
  "/operator/payment-providers/:id",
  zValidator("param", PaymentAccountParamSchema),
  zValidator("json", PaymentProviderAccountUpdateSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await updatePaymentProviderAccount(c.env, id, input, principal.userId);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.payment_provider.updated",
      resourceType: "payment_provider_account",
      resourceId: id,
      metadata: input,
    });
    return c.json({ data: { id, ...input } });
  },
);

paymentProviderRoutes.put(
  "/operator/payment-providers/:id/credentials",
  zValidator("param", PaymentAccountParamSchema),
  zValidator("json", PaymentProviderCredentialInputSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await replacePaymentProviderCredential(
      c.env,
      id,
      c.req.valid("json"),
      principal.userId,
    );
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.payment_provider.credentials_rotated",
      resourceType: "payment_provider_account",
      resourceId: id,
      metadata: { credentialVersion: result.credentialVersion },
    });
    return c.json({ data: result });
  },
);

paymentProviderRoutes.put(
  "/operator/payment-providers/:id/catalogue",
  zValidator("param", PaymentAccountParamSchema),
  zValidator("json", PaymentProviderCatalogueUpdateSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await replacePaymentProviderCatalogue(
      c.env,
      id,
      c.req.valid("json"),
      principal.userId,
    );
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.payment_provider.catalogue_updated",
      resourceType: "payment_provider_account",
      resourceId: id,
    });
    return c.json({ data: result });
  },
);

paymentProviderRoutes.post(
  "/operator/payment-providers/:id/test",
  zValidator("param", PaymentAccountParamSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const account = await loadPaymentProviderAccount(c.env, id);
    const result = await paymentProviderAdapter(account.provider).testAccount(account);
    await recordPaymentProviderTest(c.env, id, result);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.payment_provider.tested",
      resourceType: "payment_provider_account",
      resourceId: id,
      metadata: { status: result.status },
    });
    return c.json({ data: { id, ...result } });
  },
);

paymentProviderRoutes.post(
  "/operator/payment-providers/:id/default",
  zValidator("param", PaymentAccountParamSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    await setDefaultPaymentProviderAccount(c.env, id, principal.userId);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.payment_provider.default_changed",
      resourceType: "payment_provider_account",
      resourceId: id,
    });
    return c.json({ data: { id, isDefault: true } });
  },
);
