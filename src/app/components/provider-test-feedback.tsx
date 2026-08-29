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
  const message = pending
    ? `Checking ${label} credentials…`
    : error?.message ?? result?.message ?? `${label} could not be verified.`;

  if (tone === "pending") {
    return (
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {message}
      </span>
    );
  }

  return (
    <span
      aria-atomic="true"
      aria-live={tone === "failed" ? "assertive" : "polite"}
      className={`provider-test-feedback provider-test-feedback-${tone}`}
      role={tone === "failed" ? "alert" : "status"}
    >
      {tone === "passed" ? (
        <CheckCircle2 aria-hidden="true" size={13} />
      ) : (
        <CircleAlert aria-hidden="true" size={13} />
      )}
      <span>{tone === "passed" ? "Verified" : message}</span>
      {tone === "passed" ? <span className="sr-only">: {message}</span> : null}
    </span>
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
