import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const target = process.argv.includes("--remote") ? "--remote" : "--local";
const assumeYes = process.argv.includes("--yes");
const persistIndex = process.argv.indexOf("--persist-to");
const persistPath = persistIndex >= 0 ? process.argv[persistIndex + 1] : undefined;
if (persistIndex >= 0 && (!persistPath || target === "--remote")) {
  throw new Error("--persist-to requires a directory and is supported only with --local.");
}
const bindings = [
  "CONTROL_DB",
  ...Array.from({ length: 32 }, (_, index) => `SNAPSHOT_DB_${String(index).padStart(2, "0")}`),
];
const maxAttempts = target === "--remote" ? 3 : 1;

function retryDelay(attempt) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, attempt * 5_000);
  });
}

for (const binding of bindings) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync(
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
      [
        "d1", "migrations", "apply", binding, target,
        ...(persistPath ? ["--persist-to", resolve(persistPath)] : []),
      ],
      { stdio: assumeYes ? ["ignore", "inherit", "inherit"] : "inherit" },
    );
    if (result.status === 0) break;
    if (attempt === maxAttempts) process.exit(result.status ?? 1);
    console.warn(
      `Migration check for ${binding} failed; retrying in ${attempt * 5} seconds (${attempt}/${maxAttempts}).`,
    );
    await retryDelay(attempt);
  }
}
