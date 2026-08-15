export interface DataForSeoCredentials {
  accountId: string;
  login: string;
  password: string;
}

export function platformDataForSeoCredentials(env: Env): DataForSeoCredentials {
  return {
    accountId: "dataforseo:platform:v1",
    login: env.DATAFORSEO_LOGIN,
    password: env.DATAFORSEO_PASSWORD,
  };
}
