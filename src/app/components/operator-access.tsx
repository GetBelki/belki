import { RefreshCw, ShieldCheck } from "lucide-react";
import { useLocation } from "react-router-dom";
import { isOperatorAuthenticationFailure } from "../lib/operator-access";
import { PageHeader } from "./layout";
import { Button, Card } from "./ui";

export function OperatorDataFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const location = useLocation();
  const authenticationFailure = isOperatorAuthenticationFailure(error);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return (
    <div className="page operator-access-page page-flow">
      <PageHeader
        title={authenticationFailure
          ? "Operator authentication required"
          : "Operator data unavailable"}
        description={authenticationFailure
          ? "Your Belki session is active, but this protected area requires a separate Cloudflare Access session."
          : "The protected operator request failed before data could be returned."}
      />
      <Card className="operator-access-card" role="alert">
        <span className="operator-access-icon" aria-hidden="true">
          <ShieldCheck size={24} />
        </span>
        <div className="operator-access-copy">
          <h2>{authenticationFailure
            ? "Continue through secure operator login"
            : "We could not load the operator view"}</h2>
          <p>{authenticationFailure
            ? "Cloudflare Access will verify your operator identity, then return you to this page."
            : "Try the request again. If your Access session expired, continue through secure login to renew it."}</p>
        </div>
        <div className="operator-access-actions">
          <Button asChild>
            <a href={returnTo}>Continue to secure login</a>
          </Button>
          <Button onClick={onRetry} type="button" variant="secondary">
            <RefreshCw size={15} /> Try again
          </Button>
        </div>
        <small>Operator tools remain protected by Cloudflare Access and Belki's internal operator allowlist.</small>
      </Card>
    </div>
  );
}
