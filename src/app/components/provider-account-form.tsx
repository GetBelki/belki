import { useState, type FormEvent } from "react";
import type {
  CaptureProvider,
  CaptureProviderAccountInput,
  CaptureProviderCredentialInput,
} from "../../shared/contracts";
import {
  CAPTURE_PROVIDERS,
  CAPTURE_PROVIDER_LABELS,
} from "../../shared/capture-providers";
import { ProviderIcon } from "./provider-icon";
import { Button, Input, Label, Select } from "./ui";
import { formText } from "../lib/utils";

const PROVIDER_OPTIONS = CAPTURE_PROVIDERS.map((provider) => ({
  value: provider,
  label: CAPTURE_PROVIDER_LABELS[provider],
  icon: <ProviderIcon provider={provider} />,
}));

function credentialsFromForm(
  provider: CaptureProvider,
  data: FormData,
): CaptureProviderCredentialInput {
  switch (provider) {
    case "dataforseo":
      return {
        provider,
        credentials: {
          login: formText(data, "login"),
          password: formText(data, "password"),
        },
      };
    case "brightdata":
      return {
        provider,
        credentials: { apiToken: formText(data, "apiToken") },
      };
    case "olostep":
    case "cloro":
      return {
        provider,
        credentials: { apiKey: formText(data, "apiKey") },
      };
    case "oxylabs":
      return {
        provider,
        credentials: {
          username: formText(data, "username"),
          password: formText(data, "password"),
        },
      };
  }
}

export function ProviderCredentialFields({ provider }: { provider: CaptureProvider }) {
  if (provider === "dataforseo") {
    return (
      <>
        <div className="provider-form-field"><Label>API login</Label><Input autoComplete="off" name="login" required /></div>
        <div className="provider-form-field"><Label>API password</Label><Input autoComplete="new-password" name="password" required type="password" /></div>
      </>
    );
  }
  if (provider === "brightdata") {
    return <div className="provider-form-field"><Label>API token</Label><Input autoComplete="new-password" name="apiToken" required type="password" /></div>;
  }
  if (provider === "cloro" || provider === "olostep") {
    return <div className="provider-form-field"><Label>API key</Label><Input autoComplete="new-password" name="apiKey" required type="password" /></div>;
  }
  return (
    <>
      <div className="provider-form-field"><Label>Username</Label><Input autoComplete="off" name="username" required /></div>
      <div className="provider-form-field"><Label>Password</Label><Input autoComplete="new-password" name="password" required type="password" /></div>
    </>
  );
}

export function ProviderAccountForm({
  pending,
  error,
  submitLabel = "Connect provider",
  onSubmit,
}: {
  pending: boolean;
  error?: string;
  submitLabel?: string;
  onSubmit: (input: CaptureProviderAccountInput) => void;
}) {
  const [provider, setProvider] = useState<CaptureProvider>("dataforseo");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const credential = credentialsFromForm(provider, data);
    onSubmit({
      ...credential,
      label: formText(data, "label"),
    });
  };
  return (
    <form className="provider-form" onSubmit={submit}>
      <div className="provider-form-field">
        <Label>Provider</Label>
        <Select
          ariaLabel="Capture provider"
          onValueChange={(value) => setProvider(value as CaptureProvider)}
          options={PROVIDER_OPTIONS}
          value={provider}
        />
      </div>
      <div className="provider-form-field">
        <Label>Account label</Label>
        <Input name="label" placeholder={`${CAPTURE_PROVIDER_LABELS[provider]} primary`} required />
      </div>
      <ProviderCredentialFields provider={provider} />
      {error ? <p className="form-error">{error}</p> : null}
      <Button disabled={pending}>{pending ? "Checking credentials…" : submitLabel}</Button>
      <small className="provider-secret-note">Belki checks the credentials before storing them securely. Saved credentials are never shown.</small>
    </form>
  );
}

export function ProviderCredentialForm({
  provider,
  pending,
  error,
  onSubmit,
}: {
  provider: CaptureProvider;
  pending: boolean;
  error?: string;
  onSubmit: (input: CaptureProviderCredentialInput) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(credentialsFromForm(provider, new FormData(event.currentTarget)));
  };
  return (
    <form className="provider-form" onSubmit={submit}>
      <ProviderCredentialFields provider={provider} />
      {error ? <p className="form-error">{error}</p> : null}
      <div className="dialog-actions">
        <Button disabled={pending}>{pending ? "Checking credentials…" : "Replace credentials"}</Button>
      </div>
      <small className="provider-secret-note">Future requests use the replacement credentials as soon as Belki confirms they work.</small>
    </form>
  );
}
