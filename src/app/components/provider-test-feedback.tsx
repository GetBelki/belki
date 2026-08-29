import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

export interface ProviderTestResult {
  id: string;
  status: "passed" | "failed";
  message: string;
}

export function ProviderTestStatus({
  message,
  status,
  untestedMessage,
}: {
  message: string | null;
  status: ProviderTestResult["status"] | null;
  untestedMessage: string;
}) {
  const tone = status ?? "untested";

  return (
    <span className={`provider-test-status provider-test-status-${tone}`}>
      {status === "passed" ? (
        <CheckCircle2 aria-hidden="true" size={14} />
      ) : status === "failed" ? (
        <CircleAlert aria-hidden="true" size={14} />
      ) : (
        <RefreshCw aria-hidden="true" size={14} />
      )}
      <span>{message ?? untestedMessage}</span>
    </span>
  );
}

export function ProviderTestFeedback({
  error,
  label,
  pending,
  result,
}: {
  error: Error | null;
  label: string;
  pending: boolean;
  result: ProviderTestResult | null;
}) {
  if (!pending && !result && !error) return null;

  const tone = pending
    ? "pending"
    : error || result?.status === "failed"
      ? "failed"
      : "passed";
  const heading = tone === "pending"
    ? "Testing connection"
    : tone === "passed"
      ? "Connection verified"
      : "Connection test failed";
  const message = pending
    ? `Checking ${label} credentials…`
    : error?.message ?? result?.message ?? `${label} could not be verified.`;

  return (
    <div
      aria-atomic="true"
      aria-live={tone === "failed" ? "assertive" : "polite"}
      className={`provider-test-feedback provider-test-feedback-${tone}`}
      role={tone === "failed" ? "alert" : "status"}
    >
      {tone === "pending" ? (
        <LoaderCircle
          aria-hidden="true"
          className="provider-test-spinner"
          size={16}
        />
      ) : tone === "passed" ? (
        <CheckCircle2 aria-hidden="true" size={16} />
      ) : (
        <CircleAlert aria-hidden="true" size={16} />
      )}
      <div>
        <strong>{heading}</strong>
        <span>{message}</span>
      </div>
    </div>
  );
}

export function ProviderTestButtonContent({ pending }: { pending: boolean }) {
  return (
    <>
      {pending ? (
        <LoaderCircle
          aria-hidden="true"
          className="provider-test-spinner"
          size={14}
        />
      ) : (
        <RefreshCw aria-hidden="true" size={14} />
      )}
      {pending ? "Testing…" : "Test"}
    </>
  );
}
