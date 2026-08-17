import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkspaceUsageGate } from "../src/worker/durable-objects/workspace-usage-gate";

function entitlement(allowance = 5) {
  const start = new Date(Date.now() - 60_000).toISOString();
  const end = new Date(Date.now() + 86_400_000).toISOString();
  return {
    planKey: "starter" as const,
    subscriptionStatus: "active" as const,
    workspaceStatus: "active" as const,
    allowance,
    projectLimit: 1,
    promptLimit: 25,
    sourceLimit: 1,
    cycleStartedAt: start,
    cycleEndsAt: end,
    readOnlyUntil: null,
  };
}

function reservation(id: string, units: number) {
  return {
    reservationId: id,
    sku: "llm_standard" as const,
    units,
    resourceType: "test",
    resourceId: id,
  };
}

describe("WorkspaceUsageGate", () => {
  it("keeps workspace usage isolated", async () => {
    const first = env.WORKSPACE_USAGE.getByName("workspace-a");
    const second = env.WORKSPACE_USAGE.getByName("workspace-b");
    await first.setEntitlement(entitlement());
    await second.setEntitlement(entitlement());
    await first.reserve(reservation("a-1", 3));
    await first.commit("a-1");
    expect((await first.getSummary()).committed).toBe(3);
    expect((await second.getSummary()).committed).toBe(0);
    expect((await second.getSummary()).remaining).toBe(5);
  });

  it("is idempotent and never authorizes above the allowance", async () => {
    const stub = env.WORKSPACE_USAGE.getByName("workspace-concurrency");
    await stub.setEntitlement(entitlement(5));
    await Promise.all(Array.from({ length: 5 }, (_, index) => stub.reserve(reservation(`run-${index}`, 1))));
    const summary = await stub.getSummary();
    expect(summary.reserved).toBe(5);
    expect(summary.remaining).toBe(0);
    const repeat = await stub.reserve(reservation("run-0", 1));
    expect(repeat.status).toBe("reserved");
    expect((await stub.getSummary()).reserved).toBe(5);
    const rejected = await runInDurableObject(stub, (instance: WorkspaceUsageGate) => {
      try {
        instance.reserve(reservation("run-over-cap", 1));
        return false;
      } catch (error) {
        return String(error).includes("usage_limit");
      }
    });
    expect(rejected).toBe(true);
  });

  it("enforces project limits and read-only state", async () => {
    const stub = env.WORKSPACE_USAGE.getByName("workspace-projects");
    await stub.setEntitlement(entitlement());
    await stub.claimProject();
    const projectRejected = await runInDurableObject(stub, (instance: WorkspaceUsageGate) => {
      try {
        instance.claimProject();
        return false;
      } catch (error) {
        return String(error).includes("project_limit");
      }
    });
    expect(projectRejected).toBe(true);
    await stub.setEntitlement({ ...entitlement(), workspaceStatus: "read_only" });
    const usageRejected = await runInDurableObject(stub, (instance: WorkspaceUsageGate) => {
      try {
        instance.reserve(reservation("blocked", 1));
        return false;
      } catch (error) {
        return String(error).includes("workspace_read_only");
      }
    });
    expect(usageRejected).toBe(true);
  });

  it("starts a lower-plan allowance in the new billing period without carrying old usage", async () => {
    const stub = env.WORKSPACE_USAGE.getByName("workspace-renewal-downgrade");
    const old = entitlement(30);
    await stub.setEntitlement(old);
    await stub.reserve(reservation("old-period", 20));
    await stub.commit("old-period");
    expect((await stub.getSummary()).remaining).toBe(10);

    const nextStart = new Date(Date.now() - 1_000).toISOString();
    await stub.setEntitlement({
      ...entitlement(1),
      cycleStartedAt: nextStart,
      cycleEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await stub.getSummary()).toMatchObject({
      allowance: 1,
      committed: 0,
      reserved: 0,
      remaining: 1,
    });
  });
});
