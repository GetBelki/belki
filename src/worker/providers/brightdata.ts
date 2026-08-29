import type { CaptureProviderExecutionAdapter } from "./types";
import { boundedProviderBytes } from "./types";

const CHATGPT_DATASET_ID = "gd_m7aof0k82r803d5bjm";

export const brightDataAdapter: CaptureProviderExecutionAdapter = {
  provider: "brightdata",
  version: "brightdata-v1",
  async execute(credentials, request) {
    if (credentials.provider !== "brightdata") {
      throw new Error("Bright Data credentials are required");
    }
    if (request.source !== "chatgpt") {
      throw new Error(`Bright Data does not support ${request.source} in this adapter version`);
    }
    const response = await fetch(
      `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${CHATGPT_DATASET_ID}&format=json`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.credentials.apiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify([{
          url: "https://chatgpt.com/",
          prompt: request.query,
          web_search: request.forceWebSearch,
        }]),
      },
    );
    return {
      externalTaskId: `brightdata:${request.jobId}`,
      bytes: await boundedProviderBytes("Bright Data", response),
      requestCostUsd: null,
      providerStatusCode: response.status,
      providerStatusMessage: response.statusText || null,
    };
  },
};
