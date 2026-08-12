import { describe, expect, it } from "vitest";
import { entityGroup, normalizeEntityName } from "../src/app/lib/entity-groups";

describe("entity grouping", () => {
  it("prioritizes brands, companies, and places from provider and extracted types", () => {
    expect(entityGroup("brand")).toBe("brands");
    expect(entityGroup("local_business")).toBe("companies");
    expect(entityGroup("organization")).toBe("companies");
    expect(entityGroup("city")).toBe("places");
    expect(entityGroup("product")).toBe("other");
  });

  it("normalizes entity names for deduplication", () => {
    expect(normalizeEntityName("  Fressnapf   Burgdorf ")).toBe("fressnapf burgdorf");
  });
});
