export const MAX_PROMPT_TAGS = 10;
export const MAX_PROJECT_TAGS = 100;
export const MAX_PROMPT_TAG_LENGTH = 40;
export const PROMPT_TAG_COLOR_COUNT = 8;

export function normalizePromptTagName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function promptTagKey(value: string): string {
  return normalizePromptTagName(value).toLowerCase();
}

export function uniquePromptTagNames(values: string[]): string[] {
  const tags = new Map<string, string>();
  for (const value of values) {
    const name = normalizePromptTagName(value);
    if (name && !tags.has(promptTagKey(name))) tags.set(promptTagKey(name), name);
  }
  return [...tags.values()];
}

export function promptTagColorIndex(value: string): number {
  const normalized = promptTagKey(value);
  let hash = 2_166_136_261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % PROMPT_TAG_COLOR_COUNT;
}
