import { Globe2 } from "lucide-react";
import { localeEntry } from "../lib/locale-catalog";

export function CountryFlag({
  locationCode,
  languageCode,
  showName = true,
}: {
  locationCode: number;
  languageCode?: string;
  showName?: boolean;
}) {
  const locale = localeEntry(locationCode, languageCode);
  if (!locale?.countryCode) {
    return <span className="country-cell"><Globe2 size={15} />{showName ? "Unknown" : null}</span>;
  }
  return (
    <span className="country-cell">
      <span
        aria-hidden="true"
        className={`fi fi-${locale.countryCode.toLowerCase()}`}
      />
      {showName ? <span>{locale.locationName}</span> : null}
    </span>
  );
}
