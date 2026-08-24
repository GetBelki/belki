import { normalizePublicAppOrigin } from "../../shared/public-origin";

interface PublicOriginEnvironment {
  PUBLIC_APP_ORIGIN: string;
}

export function configuredPublicAppOrigin(
  env: PublicOriginEnvironment,
): string | null {
  const configured = env.PUBLIC_APP_ORIGIN.trim();
  return configured ? normalizePublicAppOrigin(configured) : null;
}

export function requestPublicAppOrigin(
  env: PublicOriginEnvironment,
  requestUrl: string,
): string {
  return configuredPublicAppOrigin(env) ?? normalizePublicAppOrigin(new URL(requestUrl).origin);
}

export function workspacePublicAppOrigin(
  env: PublicOriginEnvironment,
  storedOrigin: string,
): string {
  return configuredPublicAppOrigin(env) ?? normalizePublicAppOrigin(storedOrigin);
}
