import { spawnSync } from "node:child_process";

const target = process.argv.includes("--remote") ? "--remote" : "--local";
const bindings = [
  "CONTROL_DB",
  ...Array.from({ length: 32 }, (_, index) => `SNAPSHOT_DB_${String(index).padStart(2, "0")}`),
];

for (const binding of bindings) {
  const result = spawnSync(
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    ["d1", "migrations", "apply", binding, target],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
