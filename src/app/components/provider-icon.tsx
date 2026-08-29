import type { CaptureProvider } from "../../shared/contracts";
import { CAPTURE_PROVIDER_DOMAINS } from "../../shared/capture-providers";
import { DomainFavicon } from "./domain-favicon";

export function ProviderIcon({
  provider,
  size = 18,
}: {
  provider: CaptureProvider;
  size?: number;
}) {
  return (
    <span className="provider-icon" aria-hidden="true">
      <DomainFavicon domain={CAPTURE_PROVIDER_DOMAINS[provider]} size={size} />
    </span>
  );
}
