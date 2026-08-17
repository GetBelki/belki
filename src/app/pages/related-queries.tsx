import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { NoProject, PageHeader } from "../components/layout";
import { DomainFavicon } from "../components/domain-favicon";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  Input,
  Select,
  TableSkeleton,
} from "../components/ui";
import { useApp } from "../context";
import { api, apiPage } from "../lib/api";
import { localeLabel } from "../lib/locale-catalog";
import { compact, dateTime, pluralize } from "../lib/utils";
import { TRACKING_SOURCE_LABELS } from "../../shared/tracking-sources";

type RelatedQueryPeriod = "7d" | "30d" | "90d" | "365d";

interface TrackedPromptMatch {
  id: string;
  query: string;
}

interface RelatedQueryRow {
  queryKey: string;
  query: string;
  appearances: number;
  parentPrompts: number;
  firstSeen: string;
  lastSeen: string;
  trackedPrompt: TrackedPromptMatch | null;
}

interface RelatedQueriesOverview {
  period: RelatedQueryPeriod;
  indexing: boolean;
  summary: {
    appearances: number;
    uniqueQueries: number;
    responsesWithQueries: number;
    completedResponses: number;
  };
  queries: RelatedQueryRow[];
}

interface RelatedQueryDetail {
  indexing: boolean;
  period?: RelatedQueryPeriod;
  queryKey?: string;
  query?: string;
  summary?: {
    appearances: number;
    parentPrompts: number;
    firstSeen: string | null;
    lastSeen: string | null;
  };
  trackedPrompt?: TrackedPromptMatch | null;
  suggestedLocale?: { locationCode: number; languageCode: string } | null;
  parentPrompts?: Array<{
    id: string;
    query: string;
    locationCode: number;
    languageCode: string;
    appearances: number;
    lastSeen: string;
    latestSnapshotId: string;
  }>;
}

interface RelatedQueryOccurrence {
  snapshotId: string;
  capturedAt: string;
  query: string;
  prompt: {
    id: string;
    query: string;
    locationCode: number;
    languageCode: string;
  };
  citationCount: number;
  retrievedDomainsCount: number;
}

interface ContextualSource {
  url: string;
  domain: string | null;
  title: string | null;
  appearances: number;
  responses: number;
  lastSeen: string;
}

const PERIOD_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "365d", label: "Last 365 days" },
];

function periodValue(value: string | null): RelatedQueryPeriod {
  return value === "7d" || value === "90d" || value === "365d"
    ? value
    : "30d";
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function tableString(row: Record<string, React.ReactNode>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function Pagination({
  cursors,
  nextCursor,
  pageSize,
  rowCount,
  total,
  fetching,
  onChange,
}: {
  cursors: string[];
  nextCursor: string | null | undefined;
  pageSize: number;
  rowCount: number;
  total: number;
  fetching: boolean;
  onChange: (cursors: string[]) => void;
}) {
  if (!total) return null;
  const offset = cursors.length * pageSize;
  return (
    <div className="table-pagination">
      <span>{offset + 1}–{Math.min(offset + rowCount, total)} of {total}</span>
      <div>
        <Button
          disabled={!cursors.length || fetching}
          onClick={() => onChange(cursors.slice(0, -1))}
          variant="secondary"
        >
          <ChevronLeft size={14} /> Previous
        </Button>
        <Button
          disabled={!nextCursor || fetching}
          onClick={() => nextCursor && onChange([...cursors, nextCursor])}
          variant="secondary"
        >
          Next <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}

function IndexingState() {
  return (
    <Card>
      <EmptyState
        title="Preparing related queries"
        description="Belki is indexing related queries from your existing prompt snapshots. This report will fill in automatically."
      />
    </Card>
  );
}

export function RelatedQueriesPage() {
  const { projectId, trackingSource } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = periodValue(searchParams.get("period"));
  const search = searchParams.get("search") ?? "";
  const pageSize = 25;
  const scope = `${projectId ?? ""}\u0000${trackingSource}\u0000${period}\u0000${search}`;
  const [pagination, setPagination] = useState({ scope, cursors: [] as string[] });
  const cursors = pagination.scope === scope ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({
    projectId: projectId ?? "",
    period,
    source: trackingSource,
    limit: String(pageSize),
  });
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);
  const report = useQuery({
    queryKey: ["related-queries", projectId, trackingSource, period, search, cursor ?? ""],
    queryFn: () =>
      apiPage<RelatedQueriesOverview>(`/analytics/related-queries?${params}`),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
  const data = report.data?.data;
  const rows = data?.queries ?? [];
  const total = report.data?.page.total ?? 0;
  return (
    <div className="page related-queries-page">
      <PageHeader
        eyebrow={PERIOD_OPTIONS.find((option) => option.value === period)?.label}
        title="Related queries"
        description={`Questions ${TRACKING_SOURCE_LABELS[trackingSource]} used to expand your tracked prompts. Repeated queries reveal topics worth monitoring directly.`}
      />
      <div className="report-filters related-query-filters">
        <div className="search-filter">
          <Search size={15} />
          <Input
            aria-label="Search related queries"
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value) next.set("search", event.target.value);
              else next.delete("search");
              setSearchParams(next, { replace: true });
            }}
            placeholder="Search related queries"
            value={search}
          />
        </div>
        <Select
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "30d") next.delete("period");
            else next.set("period", value);
            setSearchParams(next, { replace: true });
          }}
          options={PERIOD_OPTIONS}
          value={period}
        />
      </div>
      {report.isPending ? (
        <Card><TableSkeleton rows={8} columns={5} /></Card>
      ) : data?.indexing ? (
        <IndexingState />
      ) : (
        <>
          <div className="related-query-stats">
            <div><span>Appearances</span><strong>{compact(data?.summary.appearances ?? 0)}</strong></div>
            <div><span>Unique queries</span><strong>{compact(data?.summary.uniqueQueries ?? 0)}</strong></div>
            <div><span>Responses with queries</span><strong>{compact(data?.summary.responsesWithQueries ?? 0)}</strong></div>
            <div><span>Completed responses</span><strong>{compact(data?.summary.completedResponses ?? 0)}</strong></div>
          </div>
          <Card>
            <CardHeader
              title="Recurring related queries"
              description="Identical queries are combined within each response and across the selected period."
              action={total ? <span className="table-total">{pluralize(total, "query", "queries")}</span> : undefined}
            />
            {rows.length ? (
              <>
                <DataTable
                  columns={[
                    { key: "query", label: "Related query" },
                    { key: "appearances", label: "Appearances" },
                    { key: "prompts", label: "Parent prompts" },
                    { key: "tracking", label: "Tracking" },
                    { key: "lastSeen", label: "Last seen" },
                    { key: "action", label: "", className: "source-row-action" },
                  ]}
                  onRowClick={(row) => {
                    const key = tableString(row, "id");
                    if (key) void navigate(`/related-queries/${key}`);
                  }}
                  rowAriaLabel={(row) => `Open details for ${tableString(row, "queryLabel")}`}
                  rows={rows.map((row) => ({
                    id: row.queryKey,
                    queryLabel: row.query,
                    query: <strong className="related-query-text">{row.query}</strong>,
                    appearances: compact(row.appearances),
                    prompts: compact(row.parentPrompts),
                    tracking: row.trackedPrompt
                      ? <Badge tone="success">Tracked</Badge>
                      : <Badge>Not tracked</Badge>,
                    lastSeen: dateTime(row.lastSeen),
                    action: <ChevronRight className="source-row-chevron" size={16} />,
                  }))}
                />
                <Pagination
                  cursors={cursors}
                  fetching={report.isFetching}
                  nextCursor={report.data?.page.nextCursor}
                  onChange={(next) => setPagination({ scope, cursors: next })}
                  pageSize={pageSize}
                  rowCount={rows.length}
                  total={total}
                />
              </>
            ) : (
              <EmptyState
                title={search ? "No matching related queries" : "No related queries yet"}
                description={search ? "Try a broader search." : `Related queries will appear when ${TRACKING_SOURCE_LABELS[trackingSource]} expands a tracked prompt.`}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function ContextSourcesCard({
  kind,
  queryKey,
  projectId,
  period,
  source,
}: {
  kind: "cited" | "retrieved";
  queryKey: string;
  projectId: string;
  period: RelatedQueryPeriod;
  source: string;
}) {
  const pageSize = 10;
  const scope = `${kind}\u0000${source}\u0000${period}\u0000${projectId}\u0000${queryKey}`;
  const [pagination, setPagination] = useState({ scope, cursors: [] as string[] });
  const cursors = pagination.scope === scope ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({ projectId, period, kind, source, limit: String(pageSize) });
  if (cursor) params.set("cursor", cursor);
  const report = useQuery({
    queryKey: ["related-query-sources", projectId, queryKey, source, period, kind, cursor ?? ""],
    queryFn: () => apiPage<ContextualSource[]>(`/analytics/related-queries/${queryKey}/sources?${params}`),
  });
  const rows = report.data?.data ?? [];
  const total = report.data?.page.total ?? 0;
  const cited = kind === "cited";
  return (
    <Card>
      <CardHeader
        title={cited ? "Cited in the same responses" : "Retrieved in the same responses"}
        description={cited
          ? "URLs explicitly cited by responses where this related query appeared."
          : "Search results retrieved by responses where this related query appeared, whether cited or not."}
        action={total ? <span className="table-total">{pluralize(total, "URL")}</span> : undefined}
      />
      {report.isPending ? <TableSkeleton rows={5} columns={4} /> : rows.length ? (
        <>
          <DataTable
            columns={[
              { key: "source", label: "Source" },
              { key: "responses", label: "Responses" },
              { key: "appearances", label: "Appearances" },
              { key: "lastSeen", label: "Last seen" },
            ]}
            rows={rows.map((row) => {
              const href = safeExternalUrl(row.url);
              return {
                id: row.url,
                source: (
                  <div className="related-source-cell">
                    {row.domain ? <DomainFavicon domain={row.domain} size={18} /> : null}
                    <span>
                      {href ? <a href={href} rel="noreferrer" target="_blank">{row.title ?? row.domain ?? row.url} <ExternalLink size={12} /></a> : <strong>{row.title ?? row.domain ?? row.url}</strong>}
                      <small>{row.domain ?? row.url}</small>
                    </span>
                  </div>
                ),
                responses: compact(row.responses),
                appearances: compact(row.appearances),
                lastSeen: dateTime(row.lastSeen),
              };
            })}
          />
          <Pagination
            cursors={cursors}
            fetching={report.isFetching}
            nextCursor={report.data?.page.nextCursor}
            onChange={(next) => setPagination({ scope, cursors: next })}
            pageSize={pageSize}
            rowCount={rows.length}
            total={total}
          />
        </>
      ) : <EmptyState title={cited ? "No cited URLs" : "No retrieved URLs"} description="No contextual URLs were stored for these responses in this period." />}
    </Card>
  );
}

export function RelatedQueryDetailPage() {
  const { projectId, session, trackingSource } = useApp();
  const { queryKey = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = periodValue(searchParams.get("period"));
  const pageSize = 10;
  const occurrenceScope = `${period}\u0000${trackingSource}\u0000${projectId ?? ""}\u0000${queryKey}`;
  const [occurrencePagination, setOccurrencePagination] = useState({
    scope: occurrenceScope,
    cursors: [] as string[],
  });
  const occurrenceCursors = occurrencePagination.scope === occurrenceScope
    ? occurrencePagination.cursors
    : [];
  const occurrenceCursor = occurrenceCursors.at(-1);
  const detail = useQuery({
    queryKey: ["related-query-detail", projectId, queryKey, trackingSource, period],
    queryFn: () => api<RelatedQueryDetail>(`/analytics/related-queries/${queryKey}?projectId=${projectId}&source=${trackingSource}&period=${period}`),
    enabled: Boolean(projectId && queryKey),
  });
  const occurrenceParams = new URLSearchParams({ projectId: projectId ?? "", source: trackingSource, period, limit: String(pageSize) });
  if (occurrenceCursor) occurrenceParams.set("cursor", occurrenceCursor);
  const occurrences = useQuery({
    queryKey: ["related-query-occurrences", projectId, queryKey, trackingSource, period, occurrenceCursor ?? ""],
    queryFn: () => apiPage<RelatedQueryOccurrence[]>(`/analytics/related-queries/${queryKey}/occurrences?${occurrenceParams}`),
    enabled: Boolean(projectId && queryKey && detail.data && !detail.data.indexing),
  });
  if (!projectId) return <NoProject />;
  if (detail.isPending) return <div className="page"><Card><TableSkeleton rows={8} columns={4} /></Card></div>;
  if (detail.data?.indexing) return <div className="page"><IndexingState /></div>;
  const data = detail.data;
  if (!data?.query || !data.summary) return null;
  const canEdit = session.user.role !== "viewer";
  const addParams = new URLSearchParams({ add: data.query });
  if (data.suggestedLocale) {
    addParams.set("addLocation", String(data.suggestedLocale.locationCode));
    addParams.set("addLanguage", data.suggestedLocale.languageCode);
  }
  const occurrenceRows = occurrences.data?.data ?? [];
  const occurrenceTotal = occurrences.data?.page.total ?? 0;
  return (
    <div className="page related-query-detail-page">
      <Link className="back-link" to={`/related-queries${period === "30d" ? "" : `?period=${period}`}`}><ArrowLeft size={14} /> Related queries</Link>
      <PageHeader
        eyebrow="Related query"
        title={data.query}
        description="Observed as a fan-out search from one or more tracked prompts."
        action={data.trackedPrompt ? (
          <Button asChild variant="secondary"><Link to={`/prompts/${data.trackedPrompt.id}`}>Open tracked prompt</Link></Button>
        ) : canEdit ? (
          <Button asChild><Link to={`/prompts?${addParams}`}><Plus size={15} /> Add as prompt</Link></Button>
        ) : undefined}
      />
      <div className="related-query-detail-toolbar">
        <Select
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "30d") next.delete("period");
            else next.set("period", value);
            setSearchParams(next, { replace: true });
          }}
          options={PERIOD_OPTIONS}
          value={period}
        />
      </div>
      <div className="related-query-stats">
        <div><span>Appearances</span><strong>{compact(data.summary.appearances)}</strong></div>
        <div><span>Parent prompts</span><strong>{compact(data.summary.parentPrompts)}</strong></div>
        <div><span>First seen</span><strong className="related-query-stat-date">{dateTime(data.summary.firstSeen)}</strong></div>
        <div><span>Last seen</span><strong className="related-query-stat-date">{dateTime(data.summary.lastSeen)}</strong></div>
      </div>
      <Card>
        <CardHeader title="Parent prompts" description="Tracked prompts whose responses produced this related query." />
        <DataTable
          columns={[
            { key: "prompt", label: "Prompt" },
            { key: "locale", label: "Locale" },
            { key: "appearances", label: "Appearances" },
            { key: "lastSeen", label: "Last seen" },
            { key: "action", label: "", className: "source-row-action" },
          ]}
          rows={(data.parentPrompts ?? []).map((prompt) => ({
            id: prompt.id,
            prompt: <Link to={`/prompts/${prompt.id}`}>{prompt.query}</Link>,
            locale: localeLabel(prompt.locationCode, prompt.languageCode),
            appearances: compact(prompt.appearances),
            lastSeen: dateTime(prompt.lastSeen),
            action: <Link aria-label={`Open latest response for ${prompt.query}`} to={`/prompts/${prompt.id}/snapshots/${prompt.latestSnapshotId}`}><ChevronRight size={16} /></Link>,
          }))}
        />
      </Card>
      <Card>
        <CardHeader title="Matching responses" description="Every captured response in which this related query appeared." action={occurrenceTotal ? <span className="table-total">{pluralize(occurrenceTotal, "response")}</span> : undefined} />
        {occurrences.isPending ? <TableSkeleton rows={6} columns={5} /> : occurrenceRows.length ? (
          <>
            <DataTable
              columns={[
                { key: "captured", label: "Captured" },
                { key: "prompt", label: "Parent prompt" },
                { key: "locale", label: "Locale" },
                { key: "sources", label: "Context" },
                { key: "action", label: "", className: "source-row-action" },
              ]}
              rows={occurrenceRows.map((row) => ({
                id: row.snapshotId,
                captured: dateTime(row.capturedAt),
                prompt: <Link to={`/prompts/${row.prompt.id}`}>{row.prompt.query}</Link>,
                locale: localeLabel(row.prompt.locationCode, row.prompt.languageCode),
                sources: `${pluralize(row.citationCount, "citation")} · ${pluralize(row.retrievedDomainsCount, "retrieved domain")}`,
                action: <Link aria-label="Open response" to={`/prompts/${row.prompt.id}/snapshots/${row.snapshotId}`}><ChevronRight size={16} /></Link>,
              }))}
            />
            <Pagination cursors={occurrenceCursors} fetching={occurrences.isFetching} nextCursor={occurrences.data?.page.nextCursor} onChange={(next) => setOccurrencePagination({ scope: occurrenceScope, cursors: next })} pageSize={pageSize} rowCount={occurrenceRows.length} total={occurrenceTotal} />
          </>
        ) : <EmptyState title="No matching responses" description="No matching responses were captured in this period." />}
      </Card>
      <div className="related-query-context-note">
        <strong>Context, not direct attribution</strong>
        <span>Providers return related queries and source lists separately. The URLs below appeared in the same responses, but Belki cannot claim that a specific query produced a specific URL.</span>
      </div>
      <div className="related-query-source-grid">
        <ContextSourcesCard kind="cited" period={period} projectId={projectId} queryKey={queryKey} source={trackingSource} />
        <ContextSourcesCard kind="retrieved" period={period} projectId={projectId} queryKey={queryKey} source={trackingSource} />
      </div>
    </div>
  );
}
