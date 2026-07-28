import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  MapPin,
  ShoppingBag,
} from "lucide-react";
import { useRef } from "react";
import { MarkdownAnswer } from "./markdown-answer";
import { Badge, Button } from "./ui";
import {
  formatPrice,
  productDestination,
  productImage,
  safeExternalUrl,
  type ProductEvidence,
  type StructuredEvidenceItem,
} from "../lib/snapshot-evidence";
import { pluralize } from "../lib/utils";

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

function StructuredBlock({
  item,
  products,
}: {
  item: StructuredEvidenceItem;
  products: ProductEvidence[];
}) {
  switch (item.type) {
    case "chat_gpt_products":
      return <ProductBlock item={item} products={products} />;
    case "chat_gpt_images":
      return <ImageBlock item={item} />;
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
  fallbackMarkdown,
}: {
  items: StructuredEvidenceItem[];
  products: ProductEvidence[];
  fallbackMarkdown: string;
}) {
  if (!items.length) return <MarkdownAnswer markdown={fallbackMarkdown} />;
  return (
    <div className="structured-answer">
      {items.map((item) => (
        <StructuredBlock key={item.id} item={item} products={products} />
      ))}
    </div>
  );
}
