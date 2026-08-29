import {
  PaymentProviderCredentialInputSchema,
  type PaymentEnvironment,
  type PaymentProvider,
  type PaymentProviderCredentialInput,
} from "../../shared/contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALGORITHM = "aes-256-gcm-hkdf-sha256" as const;
const KEY_VERSION = 1;
const HKDF_SALT = encoder.encode("belki-payment-credentials-v1");

export interface EncryptedPaymentCredential {
  algorithm: string;
  keyVersion: number;
  ciphertext: string;
  nonce: string;
}

export interface PaymentCredentialContext {
  accountId: string;
  provider: PaymentProvider;
  environment: PaymentEnvironment;
  version: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function additionalData(context: PaymentCredentialContext): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(
    `belki-payment-credentials|${context.accountId}|${context.provider}|${context.environment}|${context.version}|${KEY_VERSION}`,
  );
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return bytes;
}

async function credentialKey(masterSecret: string, accountId: string): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: encoder.encode(accountId),
    },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPaymentCredential(
  masterSecret: string,
  context: PaymentCredentialContext,
  input: PaymentProviderCredentialInput,
): Promise<EncryptedPaymentCredential> {
  if (input.provider !== context.provider) {
    throw new Error("Payment credential context does not match the payload");
  }
  const nonce = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(nonce);
  const key = await credentialKey(masterSecret, context.accountId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: additionalData(context) },
    key,
    encoder.encode(JSON.stringify(input.credentials)),
  );
  return {
    algorithm: ALGORITHM,
    keyVersion: KEY_VERSION,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    nonce: base64UrlEncode(nonce),
  };
}

export async function decryptPaymentCredential(
  masterSecret: string,
  context: PaymentCredentialContext,
  encrypted: {
    algorithm: string;
    keyVersion: number;
    ciphertext: string;
    nonce: string;
  },
): Promise<PaymentProviderCredentialInput> {
  if (encrypted.algorithm !== ALGORITHM || encrypted.keyVersion !== KEY_VERSION) {
    throw new Error("Unsupported payment credential encryption version");
  }
  const key = await credentialKey(masterSecret, context.accountId);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(encrypted.nonce),
      additionalData: additionalData(context),
    },
    key,
    base64UrlDecode(encrypted.ciphertext),
  );
  const credentials: unknown = JSON.parse(decoder.decode(plaintext));
  return PaymentProviderCredentialInputSchema.parse({
    provider: context.provider,
    credentials,
  });
}
