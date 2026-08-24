import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageMetadata = {
  cloudflare: { bindings: Record<string, { description: string }> };
};

type WranglerConfig = {
  workers_dev: boolean;
  vars: Record<string, string>;
  secrets: { required: string[] };
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as T;
}

describe("public release deployment defaults", () => {
  it("asks Deploy to Cloudflare users for exactly the required self-hosted secrets", () => {
    const packageMetadata = readJson<PackageMetadata>("../package.json");
    const wrangler = readJson<WranglerConfig>("../wrangler.jsonc");

    expect(Object.keys(packageMetadata.cloudflare.bindings).sort()).toEqual(
      [...wrangler.secrets.required].sort(),
    );
    expect(wrangler.secrets.required).not.toContain("STRIPE_SECRET_KEY");
    expect(wrangler.secrets.required).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("keeps the checked-in deployment portable and self-hosted", () => {
    const wrangler = readJson<WranglerConfig>("../wrangler.jsonc");

    expect(wrangler.workers_dev).toBe(true);
    expect(wrangler.vars.DEPLOYMENT_MODE).toBe("self_hosted");
    expect(wrangler.vars.PAYMENT_MODE).toBe("disabled");
    expect(wrangler.vars.PUBLIC_APP_ORIGIN).toBe("");
    expect(wrangler.vars.EMAIL_FROM_ADDRESS).toBe("");
  });
});
