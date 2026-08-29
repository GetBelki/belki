import { ApiError, jsonParse } from "./http";

export const STRIPE_API_VERSION = "2025-03-31.basil";

const STRIPE_API = "https://api.stripe.com/v1";
const MAX_STRIPE_BODY_BYTES = 1024 * 1024;
const STRIPE_TIMEOUT_MS = 10_000;

export interface StripeRequestOptions {
  method?: "GET" | "POST";
  params?: URLSearchParams;
  idempotencyKey?: string;
}

export type StripeEnvironment = "test" | "live";

export interface StripeClientConfiguration {
  environment: StripeEnvironment;
  secretKey: string;
}

export function optionalBinding(env: object, name: string): string | null {
  const value = Reflect.get(env, name) as unknown;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function stripeEnvironment(env: object): StripeEnvironment {
  const configured = Reflect.get(env, "environment") as unknown;
  const value = configured === "test" || configured === "live"
    ? configured
    : optionalBinding(env, "STRIPE_ENVIRONMENT");
  if (value === "test" || value === "live") return value;
  throw new ApiError(
    503,
    "billing_not_configured",
    "STRIPE_ENVIRONMENT must be set to test or live before Stripe billing is enabled.",
  );
}

export function stripeLivemode(env: object): boolean {
  return stripeEnvironment(env) === "live";
}

export function assertStripeLivemode(env: object, actual: boolean | number | null): void {
  if (actual === null || Boolean(actual) !== stripeLivemode(env)) {
    throw new ApiError(
      409,
      "stripe_environment_mismatch",
      "This Stripe resource belongs to a different test/live environment.",
    );
  }
}

export function stripeSecret(env: object): string {
  const configured = Reflect.get(env, "secretKey") as unknown;
  const value = typeof configured === "string" && configured.length > 0
    ? configured
    : optionalBinding(env, "STRIPE_SECRET_KEY");
  if (!value) throw new ApiError(503, "billing_not_configured", "Stripe billing is not configured.");
  const environment = stripeEnvironment(env);
  const allowedPrefixes = environment === "live" ? ["sk_live_", "rk_live_"] : ["sk_test_", "rk_test_"];
  if (!allowedPrefixes.some((prefix) => value.startsWith(prefix))) {
    throw new ApiError(
      503,
      "stripe_environment_mismatch",
      `The Stripe API key does not match STRIPE_ENVIRONMENT=${environment}.`,
    );
  }
  return value;
}

async function boundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_STRIPE_BODY_BYTES) {
    throw new ApiError(502, "stripe_error", "Stripe returned an oversized response.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value as Uint8Array;
    total += chunk.byteLength;
    if (total > MAX_STRIPE_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(502, "stripe_error", "Stripe returned an oversized response.");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export async function stripeRequest<T extends Record<string, unknown>>(
  env: object,
  path: string,
  options: StripeRequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const params = options.params ?? new URLSearchParams();
  const url = method === "GET" && params.size > 0
    ? `${STRIPE_API}${path}?${params.toString()}`
    : `${STRIPE_API}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${btoa(`${stripeSecret(env)}:`)}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: params } : {}),
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });
  const payload = jsonParse<T & { error?: Record<string, unknown> }>(await boundedText(response), {} as T);
  if (!response.ok) {
    const message = typeof payload.error?.message === "string"
      ? payload.error.message
      : "Stripe rejected the request.";
    const type = typeof payload.error?.type === "string" ? payload.error.type : "stripe_error";
    console.error(JSON.stringify({
      level: "error",
      message: "stripe_request_failed",
      path,
      method,
      status: response.status,
      stripeErrorType: type,
    }));
    if (response.status === 404) throw new ApiError(404, "stripe_resource_not_found", message);
    if (response.status === 409) throw new ApiError(409, "stripe_conflict", message);
    throw new ApiError(502, "stripe_error", message);
  }
  return payload;
}
