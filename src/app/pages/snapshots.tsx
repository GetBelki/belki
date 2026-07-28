import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Link, useParams } from "react-router-dom";
import { NoProject, PageHeader } from "../components/layout";
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
import { api, post } from "../lib/api";
import { localeLabel } from "../lib/locale-catalog";
import {
  fanOutLabel,
  formatPrice,
  googleShoppingUrl,
  productImage,
  safeExternalUrl,
  type EvidenceRow,
  type ProductEvidence,
  type SnapshotDetail,
  type SnapshotDiff,
  type SnapshotIndex,
} from "../lib/snapshot-evidence";
import { dateTime, pluralize } from "../lib/utils";

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
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
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
        ...(!queryId ? [{ key: "query", label: "Query" }] : []),
        { key: "model", label: "Model" },
        { key: "citations", label: "Sources" },
        { key: "entities", label: "Entities" },
        { key: "actions", label: "" },
      ]}
      rows={snapshots.map((snapshot) => {
        const detailPath = queryId
          ? `/queries/${queryId}/snapshots/${snapshot.id}`
          : `/snapshots/${snapshot.id}`;
        return {
          id: snapshot.id,
          captured: (
            <Link className="table-primary-link" to={detailPath}>
              {dateTime(snapshot.captured_at)}
            </Link>
          ),
          query: (
            <Link className="primary-cell table-query-link" to={`/queries/${snapshot.tracked_query_id}`}>
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
              <span>{snapshot.brand_entities_count} brands</span>
              <span>{snapshot.products_count} products</span>
            </div>
          ),
          actions: (
            <Button asChild variant="secondary">
              <Link to={detailPath}>View evidence</Link>
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
        title="Snapshot explorer"
        description="Audit captured answers, citations, retrievals, brands, and products."
      />
      <Card>
        {snapshots.isPending ? (
          <div className="evidence-loading"><Skeleton /><Skeleton /><Skeleton /></div>
        ) : snapshots.data?.length ? (
          <SnapshotTable snapshots={snapshots.data} />
        ) : (
          <EmptyState
            title="No snapshots yet"
            description="Completed tracking runs will appear here."
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
  if (!projectId) return <NoProject />;
  if (query.isPending) {
    return <div className="page evidence-page-loading"><Skeleton /><Skeleton /></div>;
  }
  if (!query.data) {
    return (
      <div className="page">
        <EmptyState
          title="Query unavailable"
          description="This tracked query does not exist or is no longer accessible."
          action={<Button asChild variant="secondary"><Link to="/queries">Back to queries</Link></Button>}
        />
      </div>
    );
  }
  return (
    <div className="page">
      <Link className="back-link" to="/queries"><ArrowLeft size={14} /> Tracked queries</Link>
      <PageHeader
        eyebrow="Tracked query"
        title={query.data.query_text}
        description={`${localeLabel(query.data.location_code, query.data.language_code)} · ${query.data.schedule_cadence} at ${query.data.schedule_time} · ${query.data.schedule_timezone}`}
        action={
          <Button
            variant="secondary"
            disabled={manualRun.isPending}
            onClick={() => manualRun.mutate()}
          >
            <RefreshCw size={14} />
            {manualRun.isPending ? "Queued…" : "Run now"}
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
          title="Capture history"
          description="Open a capture to inspect the full answer and its supporting evidence."
        />
        {snapshots.isPending ? (
          <div className="evidence-loading"><Skeleton /><Skeleton /></div>
        ) : snapshots.data?.length ? (
          <SnapshotTable snapshots={snapshots.data} queryId={queryId} />
        ) : (
          <EmptyState
            title="No captures yet"
            description="Run the query now or wait for its next scheduled capture."
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
      <div className="source-index">{Number(source.ordinal ?? 0) + 1}</div>
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

function ProductCard({ product }: { product: ProductEvidence }) {
  const image = productImage(product);
  const listingUrl = safeExternalUrl(product.canonical_url ?? product.raw_url);
  const price = formatPrice(product.price, product.currency);
  const rating =
    product.rating_value === null
      ? null
      : `${product.rating_value}${product.rating_max ? `/${product.rating_max}` : ""}${
          product.rating_votes_count ? ` · ${pluralize(product.rating_votes_count, "review")}` : ""
        }`;
  return (
    <article className="shopping-card">
      <div className="shopping-image">
        {image ? <img src={image} alt="" loading="lazy" /> : <ShoppingBag size={24} />}
      </div>
      <div className="shopping-card-body">
        <div className="shopping-meta">
          <span>{product.merchants ?? product.registrable_domain ?? "Merchant unavailable"}</span>
          {product.tag ? <Badge>{product.tag}</Badge> : null}
        </div>
        <h3>{product.title ?? "Untitled product"}</h3>
        <div className="shopping-facts">
          {price ? <strong>{price}</strong> : <span>Price unavailable</span>}
          {rating ? <span>{rating}</span> : null}
        </div>
        <div className="shopping-actions">
          {listingUrl ? (
            <Button asChild variant="secondary">
              <a href={listingUrl} target="_blank" rel="noreferrer">
                Open listing <ExternalLink size={13} />
              </a>
            </Button>
          ) : null}
          <Button asChild variant="secondary">
            <a href={googleShoppingUrl(product)} target="_blank" rel="noreferrer">
              Google Shopping <Search size={13} />
            </a>
          </Button>
        </div>
      </div>
    </article>
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
          title="Snapshot unavailable"
          description="The captured evidence could not be loaded."
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
    brandMentions,
  } = detail.data;
  const fanOutQueries = snapshot.fan_out_queries.map(fanOutLabel).filter(Boolean) as string[];
  const backPath = `/queries/${snapshot.tracked_query_id}`;
  const citedDomains = domains.filter((domain) => Number(domain.cited_count) > 0);
  const retrievedDomains = domains.filter((domain) => Number(domain.retrieved_count) > 0);

  return (
    <div className="page snapshot-evidence-page">
      <Link className="back-link" to={backPath}><ArrowLeft size={14} /> Query history</Link>
      <PageHeader
        eyebrow={`Captured ${dateTime(snapshot.captured_at)}`}
        title={snapshot.keyword}
        description={`${localeLabel(snapshot.location_code, snapshot.language_code)} · ${snapshot.model ?? "Unknown model"}`}
        action={
          <div className="button-group">
            {snapshot.check_url ? (
              <Button asChild variant="secondary">
                <a href={snapshot.check_url} target="_blank" rel="noreferrer">
                  Check result <ExternalLink size={14} />
                </a>
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <a href={`/api/v1/snapshots/${snapshotId}/evidence/raw`}>
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
        <div><span>Brand mentions</span><strong>{brandMentions.length}</strong></div>
        <div><span>Shopping products</span><strong>{products.length}</strong></div>
      </div>

      <div className="evidence-layout">
        <main className="evidence-main">
          <Card className="evidence-section answer-section">
            <CardHeader title="Captured answer" description="The answer text returned for this prompt." />
            <CardContent>
              <div className="answer-copy">
                {snapshot.answer_markdown || "No answer text was returned."}
              </div>
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

          {products.length ? (
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
            <CardHeader title="Evidence coverage" description="Domains and entities detected in this capture." />
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

          {brands.length ? (
            <Card className="evidence-section">
              <CardHeader title="Provider entities" description="Structured brand entities identified by the result provider." />
              <CardContent className="entity-list">
                {brands.map((brand, index) => {
                  const href = safeExternalUrl(brand.raw_url);
                  return (
                    <div key={`${String(brand.id)}-${index}`}>
                      <strong>{textValue(brand.title, "Untitled entity")}</strong>
                      <span>{textValue(brand.category ?? brand.registrable_domain)}</span>
                      {href ? <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${textValue(brand.title, "brand entity")}`}><ExternalLink size={13} /></a> : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          <Card className="evidence-section">
            <CardHeader title="Changes" description="Difference from the previous capture." />
            <CardContent><ChangeSummary diff={diff.data} /></CardContent>
          </Card>

          <Card className="evidence-section">
            <CardHeader title="Capture details" />
            <CardContent className="capture-details">
              <div><span>Model</span><strong>{snapshot.model ?? "Unknown"}</strong></div>
              <div><span>Search results</span><strong>{snapshot.se_results_count ?? "—"}</strong></div>
              <div><span>Provider status</span><strong>{snapshot.provider_status_code ?? "—"}</strong></div>
              <div><span>Provider cost</span><strong>{snapshot.provider_cost_usd === null ? "—" : `$${snapshot.provider_cost_usd.toFixed(4)}`}</strong></div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
