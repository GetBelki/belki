import { describe, expect, it } from "vitest";
import {
  LOCALE_CATALOG,
  LOCATION_OPTIONS,
  languagesForLocation,
  localeLabel,
} from "../src/app/lib/locale-catalog";

describe("DataForSEO locale catalog", () => {
  it("loads every country-language pair from the supplied catalog", () => {
    expect(LOCALE_CATALOG).toHaveLength(116);
    expect(LOCATION_OPTIONS.length).toBeGreaterThan(80);
  });

  it("constrains languages to the selected location", () => {
    expect(languagesForLocation("2840")).toEqual([
      { value: "en", label: "English (en)" },
      { value: "es", label: "Spanish (es)" },
    ]);
  });

  it("formats stored codes for the query table", () => {
    expect(localeLabel(2276, "de")).toBe("Germany · German");
  });
});
