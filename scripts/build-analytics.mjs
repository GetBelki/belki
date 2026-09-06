import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { ANALYTICS_SDK } from "../src/analytics/sdk.ts";

const { code } = await transformWithEsbuild(ANALYTICS_SDK, "belki-analytics.js", { minify: true, target: "es2020" });
const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
const headers = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
// A small SDK is delivered in one request. Hashed releases are also available
// for deployments/CDNs that deliberately pin a version. No loader waterfall.
for (const directory of ["public", "dist/analytics-assets"]) {
  await mkdir(`${directory}/assets`, { recursive: true });
  await writeFile(`${directory}/belki-analytics.js`, code);
  await writeFile(`${directory}/assets/belki-analytics.${hash}.js`, code);
  if (directory !== "public") await writeFile(`${directory}/_headers`, headers);
}
console.log(`Belki Analytics: ${Buffer.byteLength(code)} bytes, release ${hash}`);
