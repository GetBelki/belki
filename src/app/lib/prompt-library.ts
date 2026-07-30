import promptLibraryData from "../data/prompt-library.json";

export type PromptLibraryGroup =
  | "Universal"
  | "Industry"
  | "Stakeholder"
  | "Event-driven"
  | "Formulas";

export interface PromptLibraryTemplate {
  id: string;
  group: PromptLibraryGroup;
  category: string;
  text: string;
  placeholders: string[];
  suggestedTag: string;
}

const GROUPS = new Map<string, PromptLibraryGroup>([
  ["Universal brand reputation templates", "Universal"],
  ["Industry-specific reputation templates", "Industry"],
  ["Stakeholder-based reputation templates", "Stakeholder"],
  ["Event-driven reputation templates", "Event-driven"],
  ["Prompt-generation formulas", "Formulas"],
]);

function cleanTemplate(value: string): string {
  return value
    .trim()
    .replace(/`(\{[^}]+\})`/gu, "$1")
    .replace(/\s+/gu, " ");
}

function templateKey(value: string): string {
  return cleanTemplate(value).toLocaleLowerCase();
}

function isPromptTemplate(value: string): boolean {
  if (!value.includes("{")) return false;
  const prose = value.replace(/\{[a-z0-9_]+\}/giu, "").trim();
  return /[a-z]{2}/iu.test(prose);
}

export function extractPromptPlaceholders(value: string): string[] {
  const placeholders = new Set<string>();
  for (const match of value.matchAll(/\{([a-z0-9_]+)\}/giu)) {
    const name = match[1];
    if (name) placeholders.add(name.toLocaleLowerCase());
  }
  return [...placeholders];
}

export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{([a-z0-9_]+)\}/giu, (token, name: string) => {
    const replacement = variables[name.toLocaleLowerCase()]?.trim();
    return replacement || token;
  });
}

export function unresolvedPromptPlaceholders(value: string): string[] {
  return extractPromptPlaceholders(value);
}

function slug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 42);
}

export function parsePromptLibrary(markdown: string): PromptLibraryTemplate[] {
  let group: PromptLibraryGroup | null = null;
  let category = "";
  let inTextFence = false;
  const entries = new Map<
    string,
    Omit<PromptLibraryTemplate, "id"> & { ordinal: number }
  >();

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("# ")) {
      group = GROUPS.get(line.slice(2).trim()) ?? null;
      category = group === "Event-driven" ? "Reputation events" : "";
      inTextFence = false;
      continue;
    }
    if (line.startsWith("## ")) {
      category = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("```")) {
      inTextFence = !inTextFence;
      continue;
    }
    if (!group || !category) continue;

    const candidate =
      group === "Formulas"
        ? inTextFence
          ? line
          : ""
        : line.startsWith("- ")
          ? line.slice(2)
          : "";
    const text = cleanTemplate(candidate);
    if (!text || !isPromptTemplate(text)) continue;

    const key = templateKey(text);
    if (entries.has(key)) continue;
    const suggestedTag =
      group === "Event-driven" ? "Reputation events" : category;
    entries.set(key, {
      group,
      category,
      text,
      placeholders: extractPromptPlaceholders(text),
      suggestedTag,
      ordinal: entries.size + 1,
    });
  }

  return [...entries.values()].map(({ ordinal, ...template }) => ({
    ...template,
    id: `${slug(template.group)}-${slug(template.category)}-${ordinal}`,
  }));
}

export const PROMPT_LIBRARY =
  promptLibraryData as PromptLibraryTemplate[];

export const PROMPT_LIBRARY_GROUPS: PromptLibraryGroup[] = [
  "Universal",
  "Industry",
  "Stakeholder",
  "Event-driven",
  "Formulas",
];
