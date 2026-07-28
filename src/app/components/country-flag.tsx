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
  const countryCode = locale.countryCode.toLowerCase();
  return (
    <span className="country-cell">
      <img
        alt=""
        aria-hidden="true"
        className="country-flag-image"
        loading="lazy"
        src={`https://flagcdn.com/${countryCode}.svg`}
      />
      {showName ? <span>{locale.locationName}</span> : null}
    </span>
  );
}
