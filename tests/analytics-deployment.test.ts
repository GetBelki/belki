// Exercise the actual Node deployment helpers without network or real credentials.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("separate analytics deployment", () => {
  it("uses the existing explicit D1 binding and prevents parent CI name overrides", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {analyticsDatabase, analyticsDeployEnvironment, analyticsWorkerConfig} from './scripts/analytics-deployment.mjs';
      const id='cf21b68a-a943-4cf3-b12d-8ff93c8c86d6';
      const base={name:'belki',compatibility_date:'2026-08-17',d1_databases:[{binding:'CONTROL_DB',database_name:'control'}]};
      const database=analyticsDatabase(base,{analytics:{controlDatabaseId:id}});
      assert.equal(database.database_id,id);
      assert.equal(analyticsDatabase({...base,d1_databases:[{...database}]}).database_id,id);
      assert.throws(()=>analyticsDatabase(base,{analytics:{controlDatabaseId:'invalid'}}));
      const parent={WRANGLER_CI_OVERRIDE_NAME:'belki',WRANGLER_CI_MATCH_TAG:'primary-worker-tag',CLOUDFLARE_ACCOUNT_ID:'account'};
      const child=analyticsDeployEnvironment(parent,'belki-analytics');
      assert.equal(child.WRANGLER_CI_OVERRIDE_NAME,'belki-analytics');
      assert.equal(child.WRANGLER_CI_MATCH_TAG,undefined);
      assert.equal(parent.WRANGLER_CI_MATCH_TAG,'primary-worker-tag');
      assert.equal(child.CLOUDFLARE_ACCOUNT_ID,'account');
      const config=analyticsWorkerConfig(base,{PUBLIC_ANALYTICS_ORIGIN:'https://analytics.example.com'},process.cwd(),database);
      assert.equal(config.name,'belki-analytics');
      assert.equal(config.d1_databases[0].database_id,id);
      assert.equal(config.placement,undefined);
      assert.equal(config.secrets,undefined);
      console.log('verified');
    `], { cwd: process.cwd(), encoding: "utf8" });
    expect(output.trim()).toBe("verified");
  });
});
