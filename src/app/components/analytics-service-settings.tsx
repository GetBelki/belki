import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, Card, CardContent, CardHeader } from "./ui";
import type { TrafficInstallation } from "../../shared/traffic";

export function AnalyticsServiceSettings() {
  const installation = useQuery({ queryKey: ["operator-analytics"], queryFn: () => api<TrafficInstallation>("/operator/analytics") });
  const check = useMutation({ mutationFn: () => api<Array<{ name: string; ok: boolean }>>("/operator/analytics/check", { method: "POST" }) });
  return <Card><CardHeader title="Analytics service" description="Installation-wide hosting configuration. Projects manage their own authorized domains and goals." /><CardContent>
    {installation.data ? <>
      <p>Mode: <strong>{installation.data.mode === "integrated" ? "Integrated with the application" : "Separate analytics service"}</strong></p>
      <p>Script: <code>{installation.data.scriptUrl}</code></p>
      <p>Event service: <code>{installation.data.origin}</code></p>
      <p>Change hosting with <code>pnpm configure:analytics</code> or the deployment variables <code>PUBLIC_ANALYTICS_ORIGIN</code> and <code>PUBLIC_ANALYTICS_SCRIPT_URL</code>, then deploy.</p>
      <Button variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? "Checking…" : "Check service"}</Button>
      {check.data ? <p role="status">{check.data.map((result) => `${result.name}: ${result.ok ? "available" : "check failed"}`).join(" · ")}</p> : null}
    </> : <p>{installation.isPending ? "Loading analytics configuration…" : "Analytics configuration could not be loaded."}</p>}
    {installation.error || check.error ? <p role="alert">{installation.error?.message ?? check.error?.message}</p> : null}
  </CardContent></Card>;
}
