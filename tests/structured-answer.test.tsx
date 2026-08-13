import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { StructuredAnswer } from "../src/app/components/structured-answer";
import type {
  AdEvidence,
  ProductEvidence,
  StructuredEvidenceItem,
} from "../src/app/lib/snapshot-evidence";

afterEach(cleanup);

function renderWithRouter(children: ReactNode) {
  return render(<MemoryRouter>{children}</MemoryRouter>);
}

const product: ProductEvidence = {
  id: "product-1",
  snapshot_item_id: "products-1",
  provider_product_id: "provider-product-1",
  title: "Sensitive dog food",
  merchants: "example.test",
  price: 24.9,
  currency: "EUR",
  tag: null,
  canonical_url: "https://example.test/product",
  raw_url: "https://example.test/product",
  registrable_domain: "example.test",
  rating_value: 4.8,
  rating_votes_count: 12,
  rating_max: 5,
  images: ["https://example.test/product.jpg"],
  product_ids: [],
};

const adEvidence: AdEvidence = {
  id: "ad-row-1",
  snapshot_item_id: "ad-1",
  advertiser_key: "ZG9tYWluOnNoYXJlZ3JpZC5jb20",
  advertiser_name: "ShareGrid Platforms, LLC",
  advertiser_canonical_url: "https://www.sharegrid.com/",
  advertiser_domain: "sharegrid.com",
  title: "Rent Cameras + Lenses from ShareGrid",
  snippet: "Join the camera sharing community!",
  canonical_url: "https://www.sharegrid.com/",
  destination_domain: "sharegrid.com",
  image_url: "/api/v1/ads/assets/image?projectId=project",
  image_fallback_url: "https://bzrcdn.openai.com/tessera/fallback.webp",
  favicon_url: "/api/v1/ads/assets/favicon?projectId=project",
  favicon_fallback_url: "https://api.dataforseo.com/cdn/i/fallback:0",
  rank_group: 1,
  rank_absolute: 4,
  is_rendered: true,
};

function item(
  id: string,
  type: string,
  ordinal: number,
  payload: unknown,
  markdown: string | null = null,
): StructuredEvidenceItem {
  return {
    id,
    type,
    ordinal,
    rank_group: 1,
    rank_absolute: ordinal + 1,
    markdown,
    payload,
  };
}

describe("StructuredAnswer", () => {
  it("reconstructs the provider result stream in its original order", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[
          item("text-1", "chat_gpt_text", 0, {}, "Before products"),
          item("products-1", "chat_gpt_products", 1, { items: [] }),
          item("text-2", "chat_gpt_text", 2, {}, "After products"),
        ]}
        products={[product]}
        fallbackMarkdown="Fallback"
      />,
    );

    const answer = screen.getByText("Before products").closest(".structured-answer");
    expect(answer).not.toBeNull();
    const blocks = Array.from(answer!.children);
    expect(blocks[0]).toHaveTextContent("Before products");
    expect(blocks[1]).toHaveTextContent("Sensitive dog food");
    expect(blocks[2]).toHaveTextContent("After products");
    expect(
      screen.getByRole("link", { name: "Open Sensitive dog food" }),
    ).toHaveAttribute("href", "https://example.test/product");
    const performanceLink = screen.getByRole("link", {
      name: "View product performance for Sensitive dog food",
    });
    expect(performanceLink.getAttribute("href")).toMatch(
      /^\/shopping\/[A-Za-z0-9_-]+$/u,
    );
    expect(performanceLink).toHaveAttribute("target", "_blank");
    expect(performanceLink).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByLabelText("Rated 4.8 out of 5 from 12 reviews"))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next products" })).not.toBeInTheDocument();
  });

  it("adds explicit navigation controls when a product group overflows", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[item("products-1", "chat_gpt_products", 0, { items: [] })]}
        products={[
          product,
          { ...product, id: "product-2", title: "Second product" },
        ]}
        fallbackMarkdown="Fallback"
      />,
    );

    expect(screen.getByRole("button", { name: "Previous products" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next products" })).toBeInTheDocument();
  });

  it("keeps products clickable when the provider omits a direct listing", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[item("products-1", "chat_gpt_products", 0, { items: [] })]}
        products={[{ ...product, canonical_url: null, raw_url: null }]}
        fallbackMarkdown="Fallback"
      />,
    );

    const destination = screen.getByRole("link", {
      name: "Open Sensitive dog food",
    });
    expect(destination).toHaveAttribute(
      "href",
      "https://www.google.com/search?udm=28&q=Sensitive+dog+food",
    );
  });

  it("recovers a direct listing URL from the provider payload", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[
          item("products-1", "chat_gpt_products", 0, {
            items: [{
              product_id: "provider-product-1",
              title: "Sensitive dog food",
              url: "https://merchant.example/product",
            }],
          }),
        ]}
        products={[{ ...product, canonical_url: null, raw_url: null }]}
        fallbackMarkdown="Fallback"
      />,
    );

    expect(screen.getByRole("link", { name: "Open Sensitive dog food" }))
      .toHaveAttribute("href", "https://merchant.example/product");
  });

  it("renders images, navigation sources, and local result details", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[
          item("images", "chat_gpt_images", 0, {
            items: [{
              image_url: "https://example.test/image.jpg",
              url: "https://example.test/source",
              alt: "Example image",
            }],
          }),
          item("navigation", "chat_gpt_navigation_list", 1, {
            title: "Further reading",
            sources: [{
              title: "Source title",
              url: "https://example.test/article",
              snippet: "Source description",
            }],
          }),
          item("local", "chat_gpt_local_businesses", 2, {
            items: [{
              title: "Local cafe",
              address: "Main Street 1",
              phone: "+49 123",
              rating: { value: 4.7, votes_count: 21 },
            }],
          }),
        ]}
        products={[]}
        fallbackMarkdown="Fallback"
      />,
    );

    expect(screen.getByRole("img", { name: "Example image" })).toBeInTheDocument();
    const navigation = screen.getByText("Further reading").closest("section");
    expect(within(navigation!).getByRole("link", { name: /Source title/ })).toBeInTheDocument();
    expect(screen.getByText("Local cafe")).toBeInTheDocument();
    expect(screen.getByText("4.7/5 · 21 reviews · +49 123")).toBeInTheDocument();
  });

  it("renders sponsored ads in stream order with retained assets", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[
          item("text-1", "chat_gpt_text", 0, {}, "Before ad"),
          item("ad-1", "chat_gpt_ad", 1, {
            title: "Rent Cameras + Lenses from ShareGrid",
            url: "https://www.sharegrid.com/?utm_source=chatgptads",
            advertiser: { name: "ShareGrid Platforms, LLC" },
          }),
          item("text-2", "chat_gpt_text", 2, {}, "After ad"),
        ]}
        products={[]}
        ads={[adEvidence]}
        fallbackMarkdown="Fallback"
      />,
    );

    const answer = screen.getByText("Before ad").closest(".structured-answer");
    expect(Array.from(answer!.children)[1]).toHaveTextContent("Sponsored");
    expect(screen.getByText("ShareGrid Platforms, LLC")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open ad/ }))
      .toHaveAttribute("href", "https://www.sharegrid.com/");
    expect(screen.getByRole("link", { name: "Advertiser activity" }))
      .toHaveAttribute("href", `/ads/${adEvidence.advertiser_key}`);
  });

  it("does not render an ad card when the served placement was hidden", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[
          item("text-1", "chat_gpt_text", 0, {}, "Visible answer"),
          item("ad-1", "chat_gpt_ad", 1, { is_rendered: false, title: "Hidden ad" }),
        ]}
        products={[]}
        ads={[{ ...adEvidence, is_rendered: false }]}
        fallbackMarkdown="Fallback"
      />,
    );

    expect(screen.getByText("Visible answer")).toBeInTheDocument();
    expect(screen.queryByText("Hidden ad")).not.toBeInTheDocument();
    expect(screen.queryByText("Sponsored")).not.toBeInTheDocument();
  });

  it("removes ad tracking parameters when normalized evidence is unavailable", () => {
    const view = renderWithRouter(
      <StructuredAnswer
        items={[item("ad-1", "chat_gpt_ad", 0, {
          title: "Example ad",
          url: "https://example.test/landing?utm_source=chatgptads&adgroup=123",
          image_url: "https://bzrcdn.openai.com/tessera/example.webp",
          advertiser: {
            name: "Example",
            favicon_url: "https://api.dataforseo.com/cdn/i/example:0",
          },
        })]}
        products={[]}
        fallbackMarkdown="Fallback"
      />,
    );

    expect(screen.getByRole("link", { name: /Open ad/ }))
      .toHaveAttribute("href", "https://example.test/landing");
    expect(view.container.querySelector(".captured-placement-media img"))
      .toHaveAttribute("src", "https://bzrcdn.openai.com/tessera/example.webp");
    expect(view.container.querySelector(".captured-placement-brand img"))
      .toHaveAttribute("src", "https://api.dataforseo.com/cdn/i/example:0");
  });

  it("falls back to provider assets when a retained ad asset is unavailable", () => {
    const view = renderWithRouter(
      <StructuredAnswer
        items={[item("ad-1", "chat_gpt_ad", 0, { type: "chat_gpt_ad" })]}
        products={[]}
        ads={[adEvidence]}
        fallbackMarkdown="Fallback"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>(
      ".captured-placement-media img",
    );
    const favicon = view.container.querySelector<HTMLImageElement>(
      ".captured-placement-brand img",
    );
    expect(image).not.toBeNull();
    expect(favicon).not.toBeNull();
    fireEvent.error(image!);
    fireEvent.error(favicon!);
    expect(image).toHaveAttribute("src", adEvidence.image_fallback_url);
    expect(favicon).toHaveAttribute("src", adEvidence.favicon_fallback_url);
  });

  it("falls back to the combined Markdown for legacy captures", () => {
    renderWithRouter(
      <StructuredAnswer
        items={[]}
        products={[]}
        fallbackMarkdown="**Legacy answer**"
      />,
    );
    expect(screen.getByText("Legacy answer")).toBeInTheDocument();
  });
});
