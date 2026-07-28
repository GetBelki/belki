import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StructuredAnswer } from "../src/app/components/structured-answer";
import type {
  ProductEvidence,
  StructuredEvidenceItem,
} from "../src/app/lib/snapshot-evidence";

afterEach(cleanup);

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
    render(
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
    expect(screen.getByLabelText("Rated 4.8 out of 5 from 12 reviews"))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next products" })).not.toBeInTheDocument();
  });

  it("adds explicit navigation controls when a product group overflows", () => {
    render(
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

  it("does not turn products without direct listings into Shopping search links", () => {
    render(
      <StructuredAnswer
        items={[item("products-1", "chat_gpt_products", 0, { items: [] })]}
        products={[{ ...product, canonical_url: null, raw_url: null }]}
        fallbackMarkdown="Fallback"
      />,
    );

    expect(screen.getByText("Sensitive dog food")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Sensitive dog food" }))
      .not.toBeInTheDocument();
  });

  it("recovers a direct listing URL from the provider payload", () => {
    render(
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
    render(
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

  it("falls back to the combined Markdown for legacy captures", () => {
    render(
      <StructuredAnswer
        items={[]}
        products={[]}
        fallbackMarkdown="**Legacy answer**"
      />,
    );
    expect(screen.getByText("Legacy answer")).toBeInTheDocument();
  });
});
