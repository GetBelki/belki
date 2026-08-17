export interface DataForSeoCredentials {
  accountId: string;
  login: string;
  password: string;
}

interface DataForSeoCredentialEnv {
  DATAFORSEO_LOGIN: string;
  DATAFORSEO_PASSWORD: string;
}

export function platformDataForSeoCredentials(
  env: DataForSeoCredentialEnv,
): DataForSeoCredentials {
  return {
    accountId: "dataforseo:platform:v1",
    login: env.DATAFORSEO_LOGIN,
    password: env.DATAFORSEO_PASSWORD,
  };
}
