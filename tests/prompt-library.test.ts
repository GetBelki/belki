import { describe, expect, it } from "vitest";
import {
  PROMPT_LIBRARY,
  parsePromptLibrary,
  renderPromptTemplate,
  unresolvedPromptPlaceholders,
} from "../src/app/lib/prompt-library";

describe("prompt library", () => {
  it("parses the curated template file without placeholder documentation", () => {
    expect(PROMPT_LIBRARY.length).toBeGreaterThan(250);
    expect(
      PROMPT_LIBRARY.some(
        (template) => template.text === "What is {brand} known for?",
      ),
    ).toBe(true);
    expect(
      PROMPT_LIBRARY.some((template) => template.text === "{brand}"),
    ).toBe(false);
    expect(
      PROMPT_LIBRARY.some((template) => template.text === "Product recall"),
    ).toBe(false);
  });

  it("parses formulas and de-duplicates repeated prompts", () => {
    const result = parsePromptLibrary(`
# Universal brand reputation templates
## Trust
- Is \`{brand}\` trusted?
- Is \`{brand}\` trusted?
# Prompt-generation formulas
## Reusable templates
\`\`\`text
How does {brand} compare with {competitor}?
\`\`\`
`);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      group: "Universal",
      category: "Trust",
      text: "Is {brand} trusted?",
      placeholders: ["brand"],
    });
    expect(result[1]?.group).toBe("Formulas");
  });

  it("fills known values and leaves missing values visible", () => {
    const rendered = renderPromptTemplate(
      "How does {brand} compare with {competitor} in {country}?",
      { brand: "Acme", country: "Germany" },
    );
    expect(rendered).toBe(
      "How does Acme compare with {competitor} in Germany?",
    );
    expect(unresolvedPromptPlaceholders(rendered)).toEqual(["competitor"]);
  });
});
