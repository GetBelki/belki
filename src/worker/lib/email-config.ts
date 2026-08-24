export function emailDeliveryConfigured(
  env: { EMAIL_FROM_ADDRESS: string },
): boolean {
  return env.EMAIL_FROM_ADDRESS.trim().length > 0;
}
