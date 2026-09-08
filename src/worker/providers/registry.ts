import type {
  CaptureProvider,
  CaptureProviderCredentialInput,
} from "../../shared/contracts";
import {
  CAPTURE_PROVIDER_LABELS,
  CAPTURE_PROVIDER_PRIORITY,
  CAPTURE_PROVIDER_SOURCES,
} from "../../shared/capture-providers";
import { getLocaleCatalog } from "../lib/dataforseo";
import { brightDataAdapter } from "./brightdata";
import { olostepAdapter } from "./olostep";
import { cloroAdapter } from "./cloro";
import { oxylabsAdapter } from "./oxylabs";
import type { CaptureProviderExecutionAdapter } from "./types";

export interface ProviderCredentialTestResult {
  status: "passed" | "failed";
  message: string;
}

export interface CaptureProviderAdapterDefinition {
  id: CaptureProvider;
  label: string;
  version: string;
  priority: number;
  supportedSources: typeof CAPTURE_PROVIDER_SOURCES[CaptureProvider];
  execution: CaptureProviderExecutionAdapter | null;
}

export const CAPTURE_PROVIDER_ADAPTERS: Record<
  CaptureProvider,
  CaptureProviderAdapterDefinition
> = {
  dataforseo: {
    id: "dataforseo",
    label: CAPTURE_PROVIDER_LABELS.dataforseo,
    version: "dataforseo-v1",
    priority: CAPTURE_PROVIDER_PRIORITY.dataforseo,
    supportedSources: CAPTURE_PROVIDER_SOURCES.dataforseo,
    execution: null,
  },
  brightdata: {
    id: "brightdata",
    label: CAPTURE_PROVIDER_LABELS.brightdata,
    version: "brightdata-v1",
    priority: CAPTURE_PROVIDER_PRIORITY.brightdata,
    supportedSources: CAPTURE_PROVIDER_SOURCES.brightdata,
    execution: brightDataAdapter,
  },
  cloro: {
    id: "cloro",
    label: CAPTURE_PROVIDER_LABELS.cloro,
    version: "cloro-v1",
    priority: CAPTURE_PROVIDER_PRIORITY.cloro,
    supportedSources: CAPTURE_PROVIDER_SOURCES.cloro,
    execution: cloroAdapter,
  },
  olostep: {
    id: "olostep",
    label: CAPTURE_PROVIDER_LABELS.olostep,
    version: "olostep-v1",
    priority: CAPTURE_PROVIDER_PRIORITY.olostep,
    supportedSources: CAPTURE_PROVIDER_SOURCES.olostep,
    execution: olostepAdapter,
  },
  oxylabs: {
    id: "oxylabs",
    label: CAPTURE_PROVIDER_LABELS.oxylabs,
    version: "oxylabs-v1",
    priority: CAPTURE_PROVIDER_PRIORITY.oxylabs,
    supportedSources: CAPTURE_PROVIDER_SOURCES.oxylabs,
    execution: oxylabsAdapter,
  },
};

function basicAuthorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

async function requireOk(
  providerLabel: string,
  request: Promise<Response>,
): Promise<void> {
  const response = await request;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${providerLabel} rejected these credentials.`);
    }
    throw new Error(`${providerLabel} credential check returned HTTP ${response.status}.`);
  }
  await response.body?.cancel();
}

export async function testCaptureProviderCredentials(
  input: CaptureProviderCredentialInput,
): Promise<ProviderCredentialTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    switch (input.provider) {
      case "dataforseo":
        await getLocaleCatalog(
          {
            accountId: "credential-test",
            login: input.credentials.login,
            password: input.credentials.password,
          },
          "locations",
        );
        break;
      case "brightdata":
        await requireOk(
          "Bright Data",
          fetch("https://api.brightdata.com/datasets/v3/snapshots?limit=1", {
            headers: {
              authorization: `Bearer ${input.credentials.apiToken}`,
              accept: "application/json",
            },
            signal: controller.signal,
          }),
        );
        break;
      case "cloro":
        await requireOk(
          "Cloro",
          fetch("https://api.cloro.dev/v1/credits", {
            headers: {
              authorization: `Bearer ${input.credentials.apiKey}`,
              accept: "application/json",
            },
            signal: controller.signal,
          }),
        );
        break;
      case "olostep":
        await requireOk(
          "Olostep",
          fetch("https://api.olostep.com/user/credits/info", {
            headers: {
              authorization: `Bearer ${input.credentials.apiKey}`,
              accept: "application/json",
            },
            signal: controller.signal,
          }),
        );
        break;
      case "oxylabs":
        await requireOk(
          "Oxylabs",
          fetch("https://data.oxylabs.io/v1/info/callbacker_ips", {
            headers: {
              authorization: basicAuthorization(
                input.credentials.username,
                input.credentials.password,
              ),
              accept: "application/json",
            },
            signal: controller.signal,
          }),
        );
        break;
    }
    return {
      status: "passed",
      message: `${CAPTURE_PROVIDER_LABELS[input.provider]} credentials verified.`,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `${CAPTURE_PROVIDER_LABELS[input.provider]} credential check timed out.`
      : error instanceof Error
        ? error.message
        : `${CAPTURE_PROVIDER_LABELS[input.provider]} credential check failed.`;
    return { status: "failed", message };
  } finally {
    clearTimeout(timeout);
  }
}
