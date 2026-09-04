import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const outputRoot = resolve("dist");
const sensitiveNames = new Set([".dev.vars", ".env"]);

async function removeSensitiveBuildFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await removeSensitiveBuildFiles(path);
      return;
    }
    if (sensitiveNames.has(entry.name) || entry.name.startsWith(".dev.vars.")) {
      await rm(path, { force: true });
    }
  }));
}

await removeSensitiveBuildFiles(outputRoot);
