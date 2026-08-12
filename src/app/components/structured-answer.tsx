import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  MapPin,
  Megaphone,
  ShoppingBag,
} from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { MarkdownAnswer } from "./markdown-answer";
import { Badge, Button } from "./ui";
import {
  formatPrice,
  productAnalyticsKey,
  productDestination,
  productImage,
  safeExternalUrl,
  type AdEvidence,
  type ProductEvidence,
  type StructuredEvidenceItem,
} from "../lib/snapshot-evidence";
import { pluralize } from "../lib/utils";

function ProductPerformanceIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.94436 8.04069L10.8282 8.04069M2 18L7.49762 12.5862C7.70914 12.3779 8.03957 12.3544 8.27806 12.5308L12.5239 15.6712C12.774 15.8563 13.1229 15.8204 13.3306 15.5883L21.2849 6.70262M18.1084 6H20.9306C21.4785 6 21.9259 6.44077 21.9371 6.99179L22 10.0649" />
    </svg>
  );
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadRecords(
  payload: unknown,
  key: "items" | "sources" = "items",
): UnknownRecord[] {
  const value = asRecord(payload)?.[key];
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => Boolean(item))
    : [];
}

function payloadMarkdown(item: StructuredEvidenceItem): string | null {
  return item.markdown ?? text(asRecord(item.payload)?.markdown);
}

function payloadProduct(
  item: StructuredEvidenceItem,
  value: UnknownRecord,
  index: number,
): ProductEvidence {
  const rating = asRecord(value.rating);
  return {
    ...value,
    id: `${item.id}-provider-product-${index}`,
    snapshot_item_id: item.id,
    provider_product_id: text(value.product_id),
    title: text(value.title),
    merchants: text(value.merchants),
    price: number(value.price),
    currency: text(value.currency),
    tag: text(value.tag),
    canonical_url: safeExternalUrl(value.url),
    raw_url: safeExternalUrl(value.url),
    registrable_domain: text(value.domain),
    rating_value: number(rating?.value),
    rating_votes_count: number(rating?.votes_count),
    rating_max: number(rating?.rating_max ?? rating?.max_value),
    images: Array.isArray(value.images) ? value.images : [],
    product_ids: Array.isArray(value.product_ids) ? value.product_ids : [],
  };
}

function productsForItem(
  item: StructuredEvidenceItem,
  products: ProductEvidence[],
): ProductEvidence[] {
  const stored = products.filter((product) => product.snapshot_item_id === item.id);
  const providerProducts = payloadRecords(item.payload);
  if (stored.length) {
    return stored.map((product, index) => {
      const providerProduct =
        providerProducts.find(
          (value) =>
            text(value.product_id) === product.provider_product_id,
        ) ?? providerProducts[index];
      const directUrl = safeExternalUrl(providerProduct?.url);
      return {
        ...product,
        canonical_url: product.canonical_url ?? directUrl,
        raw_url: product.raw_url ?? directUrl,
      };
    });
  }
  return providerProducts.map((value, index) =>
    payloadProduct(item, value, index)
  );
}

export function ProductCard({
  product,
  compact = false,
}: {
  product: ProductEvidence;
  compact?: boolean;
}) {
  const image = productImage(product);
  const listingUrl = productDestination(product);
  const performanceUrl = `/shopping/${productAnalyticsKey(product)}`;
  const price = formatPrice(product.price, product.currency);
  const ratingMaximum =
    product.rating_max && product.rating_max > 0 ? product.rating_max : 5;
  const ratingOutOfFive =
    product.rating_value === null
      ? null
      : Math.max(0, Math.min(5, (product.rating_value / ratingMaximum) * 5));
  const filledStars =
    ratingOutOfFive === null ? 0 : Math.round(ratingOutOfFive);
  const rating =
    product.rating_value === null
      ? null
      : `${product.rating_value}${product.rating_max ? `/${product.rating_max}` : ""}${
          product.rating_votes_count
            ? ` · ${pluralize(product.rating_votes_count, "review")}`
            : ""
        }`;
  if (compact) {
    const title = product.title ?? "Untitled product";
    const content = (
      <>
        <div className="shopping-image">
          {image ? (
            <img src={image} alt="" loading="lazy" />
          ) : <ShoppingBag size={24} />}
        </div>
        <div className="shopping-card-body">
          <div className="shopping-card-summary">
            <h3>{title}</h3>
            {price ? <strong>{price}</strong> : null}
          </div>
          {ratingOutOfFive !== null ? (
            <div
              className="shopping-rating"
              aria-label={`Rated ${product.rating_value} out of ${ratingMaximum}${
                product.rating_votes_count
                  ? ` from ${pluralize(product.rating_votes_count, "review")}`
                  : ""
              }`}
            >
              <span className="shopping-stars" aria-hidden="true">
                {Array.from({ length: 5 }, (_, index) => (
                  <span
                    className={index < filledStars ? "is-filled" : undefined}
                    key={index}
                  >
                    ★
                  </span>
                ))}
              </span>
              <span aria-hidden="true">({product.rating_value})</span>
            </div>
          ) : (
            <span className="shopping-merchant">
              {product.merchants ?? product.registrable_domain ?? "Product listing unavailable"}
            </span>
          )}
        </div>
      </>
    );
    return (
      <article className="shopping-card shopping-card-compact">
        <a
          className="shopping-card-link"
          href={listingUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${title}`}
        >
          {content}
        </a>
        <Link
          className="shopping-performance-link"
          to={performanceUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`View product performance for ${title}`}
        >
          <ProductPerformanceIcon />
          <span>Product performance</span>
        </Link>
      </article>
    );
  }
  return (
    <article className="shopping-card">
      <div className="shopping-image">
        {image ? (
          <img
            src={image}
            alt={product.title ?? "Product"}
            loading="lazy"
          />
        ) : <ShoppingBag size={24} />}
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
          <Button asChild variant="secondary">
            <a href={listingUrl} target="_blank" rel="noreferrer">
              Open product <ExternalLink size={13} />
            </a>
          </Button>
          <Link
            className="shopping-performance-button"
            to={performanceUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ProductPerformanceIcon />
            Product performance
          </Link>
        </div>
      </div>
    </article>
  );
}

function ProductBlock({
  item,
  products,
}: {
  item: StructuredEvidenceItem;
  products: ProductEvidence[];
}) {
  const values = productsForItem(item, products);
  const carouselRef = useRef<HTMLDivElement>(null);
  const moveCarousel = (direction: -1 | 1) => {
    const carousel = carouselRef.current;
    if (!carousel) return;
    carousel.scrollBy({
      left: direction * Math.max(carousel.clientWidth * 0.75, 280),
      behavior: "smooth",
    });
  };
  if (!values.length) return null;
  return (
    <section className="structured-product-block" aria-label="Shopping products">
      <div className="structured-block-heading">
        <span>Shopping products</span>
        <div className="carousel-heading-actions">
          <Badge>{values.length}</Badge>
          {values.length > 1 ? (
            <div className="carousel-controls">
              <button
                type="button"
                className="carousel-control"
                aria-label="Previous products"
                onClick={() => moveCarousel(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                className="carousel-control"
                aria-label="Next products"
                onClick={() => moveCarousel(1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="shopping-carousel" ref={carouselRef}>
        {values.map((product) => (
          <ProductCard compact key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}

function LinkListBlock({
  item,
  local = false,
}: {
  item: StructuredEvidenceItem;
  local?: boolean;
}) {
  const payload = asRecord(item.payload);
  const values = payloadRecords(
    item.payload,
    item.type === "chat_gpt_navigation_list" ? "sources" : "items",
  );
  const markdown = payloadMarkdown(item);
  if (!values.length) return markdown ? <MarkdownAnswer markdown={markdown} /> : null;
  return (
    <section className="structured-link-block">
      <div className="structured-block-heading">
        <span>
          {local
            ? "Local results"
            : text(payload?.title) ?? "Related links"}
        </span>
        <Badge>{values.length}</Badge>
      </div>
      <div className="structured-link-list">
        {values.map((value, index) => {
          const href = safeExternalUrl(value.url ?? value.link);
          const title = text(value.title ?? value.name) ?? `Result ${index + 1}`;
          const description = text(value.description ?? value.snippet);
          const address = text(value.address);
          const phone = text(value.phone);
          const rating = asRecord(value.rating);
          const ratingValue = number(rating?.value);
          const ratingVotes = number(rating?.votes_count ?? value.reviews_count);
          const body = (
            <>
              <div className="structured-link-icon">
                {local ? <MapPin size={15} /> : <ExternalLink size={14} />}
              </div>
              <div>
                <strong>{title}</strong>
                {description ? <p>{description}</p> : null}
                {address ? <span>{address}</span> : null}
                {phone || ratingValue !== null ? (
                  <span>
                    {[
                      ratingValue !== null
                        ? `${ratingValue}/5${ratingVotes ? ` · ${ratingVotes} reviews` : ""}`
                        : null,
                      phone,
                    ].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </div>
            </>
          );
          return href ? (
            <a key={`${title}-${index}`} href={href} target="_blank" rel="noreferrer">
              {body}
            </a>
          ) : (
            <div key={`${title}-${index}`}>{body}</div>
          );
        })}
      </div>
    </section>
  );
}

function ImageBlock({ item }: { item: StructuredEvidenceItem }) {
  const images = payloadRecords(item.payload)
    .map((value, index) => ({
      src: safeExternalUrl(value.image_url ?? value.image ?? value.url ?? value.src),
      href: safeExternalUrl(value.source_url ?? value.link ?? value.url),
      alt: text(value.alt ?? value.title) ?? `Result image ${index + 1}`,
    }))
    .filter((image): image is { src: string; href: string | null; alt: string } =>
      Boolean(image.src)
    );
  if (!images.length) {
    const markdown = payloadMarkdown(item);
    return markdown ? <MarkdownAnswer markdown={markdown} /> : null;
  }
  return (
    <section className="structured-image-block">
      <div className="structured-block-heading">
        <span><ImageIcon size={14} /> Images</span>
        <Badge>{images.length}</Badge>
      </div>
      <div className="structured-image-grid">
        {images.map((image, index) => {
          const content = <img src={image.src} alt={image.alt} loading="lazy" />;
          return image.href ? (
            <a key={`${image.src}-${index}`} href={image.href} target="_blank" rel="noreferrer">
              {content}
            </a>
          ) : <div key={`${image.src}-${index}`}>{content}</div>;
        })}
      </div>
    </section>
  );
}

function cleanAdDestination(value: unknown): string | null {
  const safe = safeExternalUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  const tracking = new Set([
    "adgroup", "adgroupid", "campaign", "campaignid", "creative",
    "creativeid", "keyword", "matchtype", "network", "device",
  ]);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || tracking.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  return url.href;
}

function AdBlock({
  item,
  ads,
}: {
  item: StructuredEvidenceItem;
  ads: AdEvidence[];
}) {
  const payload = asRecord(item.payload);
  const advertiser = asRecord(payload?.advertiser);
  const stored = ads.find((ad) => ad.snapshot_item_id === item.id);
  const advertiserName = stored?.advertiser_name
    ?? text(advertiser?.name)
    ?? stored?.advertiser_domain
    ?? text(payload?.domain)
    ?? "Advertiser";
  const title = stored?.title ?? text(payload?.title) ?? "Sponsored result";
  const snippet = stored?.snippet ?? text(payload?.snippet);
  const destination = stored?.canonical_url
    ?? cleanAdDestination(payload?.url)
    ?? stored?.advertiser_canonical_url
    ?? cleanAdDestination(advertiser?.url);
  const domain = stored?.destination_domain
    ?? stored?.advertiser_domain
    ?? text(payload?.domain);
  const image = stored?.image_url ?? safeExternalUrl(payload?.image_url);
  const favicon = stored?.favicon_url ?? safeExternalUrl(advertiser?.favicon_url);
  return (
    <section className="structured-ad-block" aria-label={`Sponsored ad from ${advertiserName}`}>
      <div className="structured-block-heading">
        <span><Megaphone size={14} /> Sponsored</span>
        {item.rank_absolute ? <Badge>Position {item.rank_absolute}</Badge> : null}
      </div>
      <article className="ad-card">
        <div className="ad-card-image">
          {image ? <img src={image} alt="" loading="lazy" /> : <Megaphone size={24} />}
        </div>
        <div className="ad-card-body">
          <div className="ad-advertiser">
            {favicon ? <img src={favicon} alt="" loading="lazy" /> : null}
            <strong>{advertiserName}</strong>
            {domain ? <span>{domain}</span> : null}
          </div>
          <h3>{title}</h3>
          {snippet ? <p>{snippet}</p> : null}
          <div className="ad-card-actions">
            {destination ? (
              <Button asChild variant="secondary">
                <a href={destination} target="_blank" rel="noreferrer">
                  Open ad <ExternalLink size={13} />
                </a>
              </Button>
            ) : null}
            {stored?.advertiser_key ? (
              <Link className="ad-performance-link" to={`/ads/${stored.advertiser_key}`}>
                Advertiser activity
              </Link>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}

function StructuredBlock({
  item,
  products,
  ads,
}: {
  item: StructuredEvidenceItem;
  products: ProductEvidence[];
  ads: AdEvidence[];
}) {
  switch (item.type) {
    case "chat_gpt_products":
      return <ProductBlock item={item} products={products} />;
    case "chat_gpt_images":
      return <ImageBlock item={item} />;
    case "chat_gpt_ad":
      return <AdBlock item={item} ads={ads} />;
    case "chat_gpt_navigation_list":
      return <LinkListBlock item={item} />;
    case "chat_gpt_local_businesses":
      return <LinkListBlock item={item} local />;
    default: {
      const markdown = payloadMarkdown(item);
      return markdown ? <MarkdownAnswer markdown={markdown} /> : null;
    }
  }
}

export function StructuredAnswer({
  items,
  products,
  ads = [],
  fallbackMarkdown,
}: {
  items: StructuredEvidenceItem[];
  products: ProductEvidence[];
  ads?: AdEvidence[];
  fallbackMarkdown: string;
}) {
  if (!items.length) return <MarkdownAnswer markdown={fallbackMarkdown} />;
  return (
    <div className="structured-answer">
      {items.map((item) => (
        <StructuredBlock key={item.id} item={item} products={products} ads={ads} />
      ))}
    </div>
  );
}
