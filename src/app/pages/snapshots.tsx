import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ExternalLink,
  FileJson,
  Globe2,
  RefreshCw,
  Search,
  ShoppingBag,
} from "lucide-react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useEffect } from "react";
import { NoProject, PageHeader } from "../components/layout";
import { DomainFavicon } from "../components/domain-favicon";
import { ProductCard, StructuredAnswer } from "../components/structured-answer";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  DataTable,
  EmptyState,
  Skeleton,
} from "../components/ui";
import { useApp } from "../context";
import { api, apiPage, post } from "../lib/api";
import { ENTITY_GROUPS, entityGroup, normalizeEntityName } from "../lib/entity-groups";
import { localeLabel } from "../lib/locale-catalog";
import { isRunInProgress, runStatusLabel } from "../lib/run-status";
import {
  fanOutLabel,
  safeExternalUrl,
  type EvidenceRow,
  type SnapshotDetail,
  type SnapshotDiff,
  type SnapshotIndex,
} from "../lib/snapshot-evidence";
import { dateTime } from "../lib/utils";
import type { RunStatus } from "../../shared/contracts";

interface TrackedQuery {
  id: string;
  project_id: string;
  project_name: string;
  query_text: string;
  location_code: number;
  language_code: string;
  schedule_cadence: "daily" | "weekly";
  schedule_time: string;
  schedule_timezone: string;
  is_active: number;
  last_snapshot_at: string | null;
  snapshot_count: number;
  latest_run_status: RunStatus | null;
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function EntityNameGroups({
  entities,
}: {
  entities: Array<{ id: string; name: string; type: string; href?: string | null }>;
}) {
  const unique = Array.from(new Map(
    entities
      .filter((entity) => entity.name.trim())
      .map((entity) => [normalizeEntityName(entity.name), entity]),
  ).values());

  return (
    <div className="entity-name-groups">
      {ENTITY_GROUPS.map((group) => {
        const matches = unique
          .filter((entity) => entityGroup(entity.type) === group.key)
          .sort((left, right) => left.name.localeCompare(right.name));
        if (!matches.length) return null;
        return (
          <section className="entity-name-group" key={group.key}>
            <h4>{group.label}<span>{matches.length}</span></h4>
            <ul>
              {matches.map((entity) => (
                <li key={entity.id}>
                  <strong>{entity.name}</strong>
                  {entity.href ? (
                    <a href={entity.href} target="_blank" rel="noreferrer" aria-label={`Open ${entity.name}`}>
                      <ExternalLink size={13} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SnapshotTable({
  snapshots,
  queryId,
}: {
  snapshots: SnapshotIndex[];
  queryId?: string;
}) {
  return (
    <DataTable
      columns={[
        { key: "captured", label: "Captured" },
        ...(!queryId ? [{ key: "query", label: "Prompt" }] : []),
        { key: "model", label: "Model" },
        { key: "citations", label: "Sources" },
        { key: "entities", label: "Entities" },
        { key: "actions", label: "" },
      ]}
      rows={snapshots.map((snapshot) => {
        const detailPath = queryId
          ? `/prompts/${queryId}/snapshots/${snapshot.id}`
          : `/snapshots/${snapshot.id}`;
        return {
          id: snapshot.id,
          captured: (
            <Link className="table-primary-link" to={detailPath}>
              {dateTime(snapshot.captured_at)}
            </Link>
          ),
          query: (
            <Link className="primary-cell table-query-link" to={`/prompts/${snapshot.tracked_query_id}`}>
              <strong>{snapshot.query_text}</strong>
              <span>View capture history</span>
            </Link>
          ),
          model: <Badge tone="info">{snapshot.model ?? "Unknown"}</Badge>,
          citations: (
            <div className="metric-pair">
              <span><ArrowUpRight size={13} /> {snapshot.cited_domains_count} cited</span>
              <span><ArrowDownRight size={13} /> {snapshot.retrieved_domains_count} retrieved</span>
            </div>
          ),
          entities: (
            <div className="metric-pair">
              <span>{snapshot.detected_entities_count} detected</span>
              <span>{snapshot.products_count} products</span>
            </div>
          ),
          actions: (
            <Button asChild variant="secondary">
              <Link to={detailPath}>View response</Link>
            </Button>
          ),
        };
      })}
    />
  );
}

export function SnapshotExplorerPage() {
  const { projectId } = useApp();
  const snapshots = useQuery({
    queryKey: ["snapshots", projectId],
    queryFn: () => api<SnapshotIndex[]>(`/snapshots?projectId=${projectId}`),
    enabled: Boolean(projectId),
  });
  if (!projectId) return <NoProject />;
  return (
    <div className="page">
      <PageHeader
        title="Response history"
        description="Review captured AI responses, citations, sources, brand mentions, and shopping products."
      />
      <Card>
        {snapshots.isPending ? (
          <div className="evidence-loading"><Skeleton /><Skeleton /><Skeleton /></div>
        ) : snapshots.data?.length ? (
          <SnapshotTable snapshots={snapshots.data} />
        ) : (
          <EmptyState
            title="No responses yet"
            description="Completed prompt runs will appear here."
          />
        )}
      </Card>
    </div>
  );
}

export function QuerySnapshotsPage() {
  const { projectId } = useApp();
  const { queryId = "" } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["query", queryId],
    queryFn: () => api<TrackedQuery>(`/queries/${queryId}`),
    enabled: Boolean(queryId),
    refetchInterval: (current) =>
      isRunInProgress(current.state.data?.latest_run_status) ? 3_000 : false,
  });
  const snapshots = useQuery({
    queryKey: ["snapshots", projectId, queryId],
    queryFn: () =>
      api<SnapshotIndex[]>(`/snapshots?projectId=${projectId}&queryId=${queryId}`),
    enabled: Boolean(projectId && queryId),
  });
  const manualRun = useMutation({
    mutationFn: () => post(`/queries/${queryId}/runs`, { captureHtml: false }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["query", queryId] }),
        queryClient.invalidateQueries({ queryKey: ["snapshots", projectId, queryId] }),
      ]);
    },
  });
  useEffect(() => {
    if (query.data?.latest_run_status === "completed") {
      void queryClient.invalidateQueries({
        queryKey: ["snapshots", projectId, queryId],
      });
    }
  }, [
    projectId,
    query.data?.latest_run_status,
    query.data?.snapshot_count,
    queryClient,
    queryId,
  ]);
  if (!projectId) return <NoProject />;
  if (query.isPending) {
    return <div className="page evidence-page-loading"><Skeleton /><Skeleton /></div>;
  }
  if (!query.data) {
    return (
      <div className="page">
        <EmptyState
          title="Prompt unavailable"
          description="This tracked prompt does not exist or is no longer accessible."
          action={<Button asChild variant="secondary"><Link to="/prompts">Back to prompts</Link></Button>}
        />
      </div>
    );
  }
  if (snapshots.data?.[0]) {
    return (
      <Navigate
        replace
        to={`/prompts/${queryId}/snapshots/${snapshots.data[0].id}`}
      />
    );
  }
  return (
    <div className="page">
      <Link className="back-link" to="/prompts"><ArrowLeft size={14} /> Prompts</Link>
      <PageHeader
        eyebrow="Tracked prompt"
        title={query.data.query_text}
        description={`${localeLabel(query.data.location_code, query.data.language_code)} · ${query.data.schedule_cadence} at ${query.data.schedule_time} · ${query.data.schedule_timezone}`}
        action={
          <Button
            variant="secondary"
            disabled={
              manualRun.isPending ||
              isRunInProgress(query.data.latest_run_status)
            }
            onClick={() => manualRun.mutate()}
          >
            <RefreshCw size={14} />
            {manualRun.isPending
              ? "Queued…"
              : runStatusLabel(query.data.latest_run_status)}
          </Button>
        }
      />
      <div className="query-summary-strip">
        <div><span>Status</span><strong>{query.data.is_active ? "Active" : "Paused"}</strong></div>
        <div><span>Captures</span><strong>{query.data.snapshot_count}</strong></div>
        <div><span>Latest capture</span><strong>{dateTime(query.data.last_snapshot_at)}</strong></div>
      </div>
      <Card>
        <CardHeader
          title="No captures yet"
          description="Run this prompt now to create its first snapshot."
        />
        {snapshots.isPending ? (
          <div className="evidence-loading"><Skeleton /><Skeleton /></div>
        ) : (
          <EmptyState
            title="No captures yet"
            description="Run the prompt now or wait for its next scheduled capture."
          />
        )}
      </Card>
    </div>
  );
}

function EvidenceSource({
  source,
  kind,
}: {
  source: EvidenceRow;
  kind: "citation" | "retrieval";
}) {
  const href = safeExternalUrl(source.canonical_url ?? source.raw_url);
  const title = textValue(
    source.title ?? source.source_name ?? source.registrable_domain,
    "Untitled source",
  );
  const description = textValue(
    source.snippet ??
      source.description ??
      source.breadcrumb ??
      source.registrable_domain,
  );
  const meta = [
    source.source_name,
    source.registrable_domain,
    source.publication_date,
  ]
    .map((value) => textValue(value))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
  const content = (
    <>
      <DomainFavicon domain={textValue(source.registrable_domain)} />
      <div className="evidence-source-body">
        <div className="source-type">{kind === "citation" ? "Cited in answer" : "Retrieved result"}</div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
        {meta ? <span>{meta}</span> : null}
      </div>
      {href ? <ExternalLink size={14} /> : null}
    </>
  );
  return href ? (
    <a className="evidence-source" href={href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className="evidence-source">{content}</div>
  );
}

function ChangeSummary({ diff }: { diff: SnapshotDiff | undefined }) {
  if (!diff?.previous) {
    return <p className="evidence-empty-copy">This is the first capture, so there is no earlier result to compare.</p>;
  }
  const changes = [
    diff.answerChanged ? "Answer changed" : "Answer unchanged",
    diff.modelChanged ? "Model changed" : "Model unchanged",
    diff.productBlockChanged ? "Product block changed" : "Product block unchanged",
  ];
  return (
    <div className="change-summary">
      <p>Compared with <Link to={`/snapshots/${diff.previous.id}`}>{dateTime(diff.previous.capturedAt)}</Link></p>
      <div className="tag-list">{changes.map((change) => <Badge key={change}>{change}</Badge>)}</div>
      {diff.domains?.added.length || diff.domains?.removed.length ? (
        <div className="change-lines">
          {diff.domains.added.length ? <span><strong>Sources added:</strong> {diff.domains.added.join(", ")}</span> : null}
          {diff.domains.removed.length ? <span><strong>Sources removed:</strong> {diff.domains.removed.join(", ")}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function SnapshotDetailPage() {
  const { projectId } = useApp();
  const { queryId } = useParams();
  const { snapshotId = "" } = useParams();
  const detail = useQuery({
    queryKey: ["snapshot", snapshotId],
    queryFn: () => api<SnapshotDetail>(`/snapshots/${snapshotId}`),
    enabled: Boolean(snapshotId),
  });
  const diff = useQuery({
    queryKey: ["snapshot-diff", snapshotId],
    queryFn: () => api<SnapshotDiff>(`/snapshots/${snapshotId}/diff`),
    enabled: Boolean(snapshotId),
  });
  const trackedQueryId = queryId ?? detail.data?.snapshot.tracked_query_id;
  const history = useInfiniteQuery({
    queryKey: ["prompt-snapshot-history", projectId, trackedQueryId],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        projectId: projectId ?? "",
        queryId: trackedQueryId ?? "",
        limit: "10",
      });
      if (pageParam) params.set("cursor", pageParam);
      return apiPage<SnapshotIndex[]>(`/snapshots?${params}`);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
    enabled: Boolean(projectId && trackedQueryId),
  });
  if (detail.isPending) {
    return (
      <div className="page evidence-page-loading">
        <Skeleton />
        <div className="evidence-layout"><Skeleton /><Skeleton /></div>
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="page">
        <EmptyState
          title="Response unavailable"
          description="The captured AI response could not be loaded."
          action={<Button asChild variant="secondary"><Link to="/snapshots">Back to snapshots</Link></Button>}
        />
      </div>
    );
  }

  const {
    snapshot,
    sources,
    searchResults,
    brands,
    products,
    domains,
    items,
    brandMentions,
    detectedEntities,
  } = detail.data;
  const fanOutQueries = snapshot.fan_out_queries.map(fanOutLabel).filter(Boolean) as string[];
  const backPath = "/prompts";
  const citedDomains = domains.filter((domain) => Number(domain.cited_count) > 0);
  const retrievedDomains = domains.filter((domain) => Number(domain.retrieved_count) > 0);
  const hasStructuredProducts = items.some((item) => item.type === "chat_gpt_products");

  return (
    <div className="page snapshot-evidence-page">
      <Link className="back-link" to={backPath}><ArrowLeft size={14} /> Prompts</Link>
      <PageHeader
        eyebrow={`Captured ${dateTime(snapshot.captured_at)}`}
        title={snapshot.keyword}
        description={`${localeLabel(snapshot.location_code, snapshot.language_code)} · ${snapshot.model ?? "Unknown model"}`}
        action={
          <div className="button-group">
            {snapshot.has_html_evidence ? (
              <Button asChild variant="secondary">
                <a
                  href={`/api/v1/snapshots/${snapshotId}/evidence/html`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Original page <ExternalLink size={14} />
                </a>
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <a
                href={`/api/v1/snapshots/${snapshotId}/evidence/raw`}
                target="_blank"
                rel="noreferrer"
              >
                Raw JSON <FileJson size={14} />
              </a>
            </Button>
          </div>
        }
      />

      <div className="evidence-stats">
        <div><span>Citations</span><strong>{sources.length}</strong></div>
        <div><span>Retrieved results</span><strong>{searchResults.length}</strong></div>
        <div><span>Fan-out queries</span><strong>{fanOutQueries.length}</strong></div>
        <div><span>Detected entities</span><strong>{detectedEntities.length}</strong></div>
        <div><span>Shopping products</span><strong>{products.length}</strong></div>
      </div>

      <div className="evidence-layout">
        <main className="evidence-main">
          <Card className="evidence-section answer-section">
            <CardHeader title="Captured answer" description="The answer text returned for this prompt." />
            <CardContent>
              <StructuredAnswer
                items={items}
                products={products}
                fallbackMarkdown={snapshot.answer_markdown || "No answer text was returned."}
              />
            </CardContent>
          </Card>

          <Card className="evidence-section" id="citations">
            <CardHeader
              title="Cited sources"
              description="Sources explicitly referenced in the generated answer."
              action={<Badge>{sources.length}</Badge>}
            />
            <CardContent className="evidence-source-list">
              {sources.length ? sources.map((source) => (
                <EvidenceSource key={String(source.id)} source={source} kind="citation" />
              )) : <p className="evidence-empty-copy">No explicit citations were returned.</p>}
            </CardContent>
          </Card>

          <Card className="evidence-section" id="retrieved">
            <CardHeader
              title="Sources considered"
              description="Search results retrieved while producing the answer, whether cited or not."
              action={<Badge>{searchResults.length}</Badge>}
            />
            <CardContent className="evidence-source-list">
              {searchResults.length ? searchResults.map((source) => (
                <EvidenceSource key={String(source.id)} source={source} kind="retrieval" />
              )) : <p className="evidence-empty-copy">No retrieved source list was returned.</p>}
            </CardContent>
          </Card>

          {products.length && !hasStructuredProducts ? (
            <Card className="evidence-section" id="shopping">
              <CardHeader
                title="Shopping results"
                description="Product candidates included in the captured result."
                action={<Badge>{products.length}</Badge>}
              />
              <CardContent className="shopping-grid">
                {products.map((product) => <ProductCard key={product.id} product={product} />)}
              </CardContent>
            </Card>
          ) : null}
        </main>

        <aside className="evidence-rail">
          <Card className="evidence-section">
            <CardHeader title="Fan-out queries" description="Related searches generated to expand the answer." />
            <CardContent>
              {fanOutQueries.length ? (
                <ol className="fanout-list">
                  {fanOutQueries.map((query, index) => <li key={`${query}-${index}`}>{query}</li>)}
                </ol>
              ) : <p className="evidence-empty-copy">No fan-out queries were returned.</p>}
            </CardContent>
          </Card>

          <Card className="evidence-section">
            <CardHeader title="Visibility signals" description="Sources and tracked entities found in this response." />
            <CardContent className="coverage-list">
              <div><Globe2 size={15} /><span><strong>{citedDomains.length}</strong> cited domains</span></div>
              <div><Search size={15} /><span><strong>{retrievedDomains.length}</strong> retrieved domains</span></div>
              <div><ShoppingBag size={15} /><span><strong>{brandMentions.length}</strong> tracked brand mentions</span></div>
            </CardContent>
          </Card>

          {brandMentions.length ? (
            <Card className="evidence-section">
              <CardHeader title="Detected mentions" description="Tracked names or aliases found in the answer, ignoring letter case." />
              <CardContent className="entity-list">
                {brandMentions.map((brand) => (
                  <div key={brand.id}>
                    <strong>{brand.name}</strong>
                    <span>{brand.kind} · matched {brand.matchedTerms.join(", ")}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {detectedEntities.length ? (
            <Card className="evidence-section">
              <CardHeader title="Detected entities" description="Names found in the captured answer." />
              <CardContent>
                <EntityNameGroups entities={detectedEntities.map((entity) => ({
                  id: entity.id,
                  name: entity.canonical_name,
                  type: entity.entity_type,
                }))} />
              </CardContent>
            </Card>
          ) : null}

          {brands.length ? (
            <Card className="evidence-section">
              <CardHeader title="Provider entities" description="Names identified by the result provider." />
              <CardContent>
                <EntityNameGroups entities={brands.map((brand, index) => ({
                  id: `${String(brand.id)}-${index}`,
                  name: textValue(brand.title, "Untitled entity"),
                  type: textValue(brand.category, "brand"),
                  href: safeExternalUrl(brand.raw_url),
                }))} />
              </CardContent>
            </Card>
          ) : null}

          <Card className="evidence-section">
            <CardHeader title="Changes" description="Difference from the previous capture." />
            <CardContent><ChangeSummary diff={diff.data} /></CardContent>
          </Card>

          <Card className="evidence-section snapshot-timeline-card">
            <CardHeader
              title="Recent captures"
              description="Compare snapshots of this prompt."
            />
            <div className="snapshot-timeline">
              {history.data?.pages.flatMap((page) => page.data).map((item, index) => {
                const isLatest = index === 0;
                const isCurrent = item.id === snapshotId;
                return (
                  <Link
                    className={`snapshot-timeline-item${isCurrent ? " active" : ""}`}
                    key={item.id}
                    to={`/prompts/${snapshot.tracked_query_id}/snapshots/${item.id}`}
                  >
                    <span>{isLatest ? "Latest" : dateTime(item.captured_at)}</span>
                    <strong>{dateTime(item.captured_at)}</strong>
                    <small>{item.cited_domains_count} cited · {item.products_count} products</small>
                  </Link>
                );
              })}
            </div>
            {history.hasNextPage ? (
              <div className="snapshot-timeline-footer">
                <Button
                  variant="secondary"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  {history.isFetchingNextPage ? "Loading…" : "Load older captures"}
                </Button>
              </div>
            ) : null}
          </Card>
        </aside>
      </div>
    </div>
  );
}
