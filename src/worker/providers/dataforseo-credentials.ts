import type { DataForSeoCredentials } from "../lib/provider-credentials";
import { resolveCaptureProviderByProvider } from "./accounts";

export async function registeredDataForSeoCredentials(
  env: Env,
): Promise<DataForSeoCredentials> {
  const account = await resolveCaptureProviderByProvider(env, "dataforseo");
  if (account.credentials.provider !== "dataforseo") {
    throw new Error("Configured DataForSEO account has incompatible credentials");
  }
  return {
    accountId: account.accountId,
    login: account.credentials.credentials.login,
    password: account.credentials.credentials.password,
  };
}
