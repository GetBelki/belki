import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const target = process.argv.includes("--remote") ? "--remote" : "--local";
const persistIndex = process.argv.indexOf("--persist-to");
const persistPath = persistIndex >= 0 ? process.argv[persistIndex + 1] : undefined;
if (persistIndex >= 0 && (!persistPath || target === "--remote")) {
  throw new Error("--persist-to requires a directory and is supported only with --local.");
}
const bindings = [
  "CONTROL_DB",
  ...Array.from({ length: 32 }, (_, index) => `SNAPSHOT_DB_${String(index).padStart(2, "0")}`),
];

for (const binding of bindings) {
  const result = spawnSync(
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    [
      "d1", "migrations", "apply", binding, target,
      ...(persistPath ? ["--persist-to", resolve(persistPath)] : []),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
