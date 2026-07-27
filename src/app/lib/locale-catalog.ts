import rawCatalog from "../data/dataforseo-locales.csv?raw";

export interface LocaleCatalogEntry {
  locationCode: number;
  locationName: string;
  countryCode: string;
  locationType: string;
  languageName: string;
  languageCode: string;
}

function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  fields.push(value);
  return fields;
}

export const LOCALE_CATALOG: LocaleCatalogEntry[] = rawCatalog
  .trim()
  .split(/\r?\n/u)
  .slice(1)
  .map((row) => {
    const fields = parseCsvRow(row);
    return {
      locationCode: Number(fields[0]),
      locationName: fields[1] ?? "",
      countryCode: fields[3] ?? "",
      locationType: fields[4] ?? "",
      languageName: fields[6] ?? "",
      languageCode: fields[7] ?? "",
    };
  })
  .filter(
    (entry) =>
      Number.isInteger(entry.locationCode) &&
      entry.locationName.length > 0 &&
      entry.languageCode.length > 0,
  )
  .sort(
    (left, right) =>
      left.locationName.localeCompare(right.locationName) ||
      left.languageName.localeCompare(right.languageName),
  );

export const LOCATION_OPTIONS = [
  ...new Map(
    LOCALE_CATALOG.map((entry) => [
      String(entry.locationCode),
      {
        value: String(entry.locationCode),
        label: `${entry.locationName} (${entry.countryCode})`,
      },
    ]),
  ).values(),
];

export function languagesForLocation(locationCode: string): Array<{
  value: string;
  label: string;
}> {
  return LOCALE_CATALOG
    .filter((entry) => String(entry.locationCode) === locationCode)
    .map((entry) => ({
      value: entry.languageCode,
      label: `${entry.languageName} (${entry.languageCode})`,
    }));
}

export function localeLabel(locationCode: number, languageCode: string): string {
  const entry = LOCALE_CATALOG.find(
    (candidate) =>
      candidate.locationCode === locationCode &&
      candidate.languageCode === languageCode,
  );
  return entry
    ? `${entry.locationName} · ${entry.languageName}`
    : `Location ${locationCode} · ${languageCode}`;
}
