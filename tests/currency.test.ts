import { describe, expect, it } from "vitest";
import {
  currencyMinorUnitDigits,
  formatCurrencyMinorInput,
  normalizeCurrencyCode,
  parseCurrencyAmountToMinor,
} from "../src/shared/currency";

describe("payment currency helpers", () => {
  it("normalizes ISO codes and converts decimal prices without floating-point rounding", () => {
    expect(normalizeCurrencyCode(" brl ")).toBe("BRL");
    expect(parseCurrencyAmountToMinor("49.90", "BRL")).toBe(4_990);
    expect(parseCurrencyAmountToMinor("10.125", "BHD")).toBe(10_125);
  });

  it("supports currencies with no minor unit", () => {
    expect(currencyMinorUnitDigits("JPY")).toBe(0);
    expect(parseCurrencyAmountToMinor("1500.00", "JPY")).toBe(1_500);
    expect(formatCurrencyMinorInput(1_500, "JPY")).toBe("1500");
    expect(() => parseCurrencyAmountToMinor("1500.50", "JPY")).toThrow(/at most 0 decimal places/u);
  });

  it("rejects malformed currencies and amounts", () => {
    expect(() => normalizeCurrencyCode("EURO")).toThrow(/three-letter ISO 4217/u);
    expect(() => parseCurrencyAmountToMinor("10,50", "EUR")).toThrow(/decimal point/u);
    expect(() => parseCurrencyAmountToMinor("0", "USD")).toThrow(/greater than zero/u);
  });
});
