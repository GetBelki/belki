import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  CaptureProviderAccountInputSchema,
  CaptureProviderAccountUpdateSchema,
  CaptureProviderCredentialInputSchema,
  CaptureProviderRouteUpdateSchema,
  TrackingSourceSchema,
} from "../../shared/contracts";
import type { AppEnv } from "../lib/app";
import { assertOperator } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import {
  captureProviderActivity,
  captureProviderConfiguration,
  createCaptureProviderAccount,
  loadCaptureProviderCredential,
  recordCaptureProviderTest,
  replaceCaptureProviderCredential,
  setDefaultCaptureProviderAccount,
  updateCaptureProviderAccount,
  updateCaptureProviderRoute,
} from "../providers/accounts";
import { testCaptureProviderCredentials } from "../providers/registry";

const ProviderAccountParamSchema = z.object({ id: z.string().trim().min(1).max(200) });
const ProviderRouteParamSchema = z.object({ source: TrackingSourceSchema });

export const providerRoutes = new Hono<AppEnv>();

providerRoutes.get("/operator/providers", async (c) => {
  await assertOperator(c);
  const [configuration, activity] = await Promise.all([
    captureProviderConfiguration(c.env),
    captureProviderActivity(c.env),
  ]);
  return c.json({ data: { ...configuration, activity } });
});

providerRoutes.post(
  "/operator/providers",
  zValidator("json", CaptureProviderAccountInputSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const input = c.req.valid("json");
    const credentialInput = {
      provider: input.provider,
      credentials: input.credentials,
    } as Parameters<typeof testCaptureProviderCredentials>[0];
    const test = await testCaptureProviderCredentials(credentialInput);
    const account = await createCaptureProviderAccount(
      c.env,
      input,
      principal.userId,
      test,
    );
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.capture_provider.created",
      resourceType: "capture_provider_account",
      resourceId: account.id,
      metadata: { provider: account.provider, isDefault: account.isDefault },
    });
    return c.json({ data: account }, 201);
  },
);

providerRoutes.patch(
  "/operator/providers/:id",
  zValidator("param", ProviderAccountParamSchema),
  zValidator("json", CaptureProviderAccountUpdateSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await updateCaptureProviderAccount(c.env, id, input, principal.userId);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.capture_provider.updated",
      resourceType: "capture_provider_account",
      resourceId: id,
      metadata: input,
    });
    return c.json({ data: { id, ...input } });
  },
);

providerRoutes.put(
  "/operator/providers/:id/credentials",
  zValidator("param", ProviderAccountParamSchema),
  zValidator("json", CaptureProviderCredentialInputSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const test = await testCaptureProviderCredentials(input);
    const result = await replaceCaptureProviderCredential(
      c.env,
      id,
      input,
      principal.userId,
      test,
    );
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.capture_provider.credentials_rotated",
      resourceType: "capture_provider_account",
      resourceId: id,
      metadata: { credentialVersion: result.credentialVersion },
    });
    return c.json({ data: result });
  },
);

providerRoutes.post(
  "/operator/providers/:id/test",
  zValidator("param", ProviderAccountParamSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const credentials = await loadCaptureProviderCredential(c.env, id);
    const result = await testCaptureProviderCredentials(credentials);
    await recordCaptureProviderTest(c.env, id, result);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.capture_provider.tested",
      resourceType: "capture_provider_account",
      resourceId: id,
      metadata: { status: result.status },
    });
    return c.json({ data: { id, ...result } });
  },
);

providerRoutes.post(
  "/operator/providers/:id/default",
  zValidator("param", ProviderAccountParamSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    await setDefaultCaptureProviderAccount(c.env, id, principal.userId);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.capture_provider.default_changed",
      resourceType: "capture_provider_account",
      resourceId: id,
    });
    return c.json({ data: { id, isDefault: true } });
  },
);

providerRoutes.patch(
  "/operator/platforms/:source",
  zValidator("param", ProviderRouteParamSchema),
  zValidator("json", CaptureProviderRouteUpdateSchema),
  async (c) => {
    await assertOperator(c);
    const principal = c.get("principal");
    const { source } = c.req.valid("param");
    const input = c.req.valid("json");
    await updateCaptureProviderRoute(c.env, source, input, principal.userId);
    await writeAudit(c.env.CONTROL_DB, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "operator.capture_provider.route_updated",
      resourceType: "tracking_source",
      resourceId: source,
      metadata: input,
    });
    return c.json({ data: { trackingSource: source, ...input } });
  },
);
