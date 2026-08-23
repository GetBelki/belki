import { ApiClientError } from "./api";

export function isOperatorAuthenticationFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof ApiClientError
    && (
      [401, 403].includes(error.status)
      || error.code === "cloudflare_access_required"
      || (error.code === "request_failed" && error.status < 400)
    );
}
