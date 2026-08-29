const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;

export function normalizeCurrencyCode(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new Error("Currency must be a three-letter ISO 4217 code, such as EUR or USD.");
  }
  return currency;
}

export function currencyMinorUnitDigits(value: string): number {
  const currency = normalizeCurrencyCode(value);
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    if (digits === undefined) throw new Error("Currency minor units are unavailable.");
    return digits;
  } catch {
    throw new Error(`${currency} is not a supported ISO 4217 currency code.`);
  }
}

export function parseCurrencyAmountToMinor(value: string, currencyValue: string): number {
  const currency = normalizeCurrencyCode(currencyValue);
  const digits = currencyMinorUnitDigits(currency);
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error(`Enter a valid ${currency} amount using a decimal point.`);
  }
  const [whole, rawFraction = ""] = normalized.split(".");
  const significantExtra = rawFraction.slice(digits).replace(/0/gu, "");
  if (significantExtra) {
    throw new Error(`${currency} supports at most ${digits} decimal place${digits === 1 ? "" : "s"}.`);
  }
  const fraction = rawFraction.slice(0, digits).padEnd(digits, "0");
  const minor = Number(`${whole}${fraction}`);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("Plan amount must be greater than zero and within the supported range.");
  }
  return minor;
}

export function formatCurrencyMinorInput(amountMinor: number, currencyValue: string): string {
  const digits = currencyMinorUnitDigits(currencyValue);
  if (digits === 0) return String(amountMinor);
  const padded = String(amountMinor).padStart(digits + 1, "0");
  return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

export function formatCurrencyMinorAmount(
  amountMinor: number,
  currencyValue: string,
  locale?: string,
): string {
  const currency = normalizeCurrencyCode(currencyValue);
  const digits = currencyMinorUnitDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amountMinor / (10 ** digits));
}
