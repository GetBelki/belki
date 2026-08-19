import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductMetricCard,
  RankComparisonChart,
} from "../src/app/pages/insights";
import { productDetailRows } from "../src/app/lib/product-analytics";

afterEach(cleanup);

const product = {
  id: "product-row",
  productKey: "product-key",
  title: "Designer Bar",
  merchants: "Example shop",
  registrable_domain: "example.com",
  price: 3.79,
  currency: "EUR",
  canonical_url: "https://example.com/product",
  raw_url: null,
  rating_value: 4.8,
  rating_votes_count: 120,
  images: ["https://example.com/product.png"],
  product_ids: [],
  appearances: 4,
  latestSeen: "2026-08-19T09:00:00.000Z",
  enriched: true,
  ordinal: 0,
  rating_max: 5,
};

describe("product analytics UI", () => {
  it("exposes metric definitions and comparison context", () => {
    render(
      <ProductMetricCard
        delta="+8.0 pp vs previous period"
        deltaTone="positive"
        description="12 of 25 captures"
        help="Share of completed captures containing the product."
        icon={<span aria-hidden="true">V</span>}
        label="Visibility"
        value="48%"
      />,
    );

    expect(screen.getByText("48%")).toBeInTheDocument();
    expect(screen.getByText("+8.0 pp vs previous period")).toHaveClass(
      "is-positive",
    );
    expect(
      screen.getByLabelText("Share of completed captures containing the product."),
    ).toBeInTheDocument();
  });

  it("renders one-observation rank samples as points", () => {
    const { container } = render(
      <MemoryRouter>
        <RankComparisonChart
          product={product}
          competition={{
            current: {
              count: 1,
              minimum: 1,
              firstQuartile: 1,
              median: 1,
              thirdQuartile: 1,
              maximum: 1,
            },
            coFeatured: [],
          }}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector(".product-rank-point")).toBeInTheDocument();
    expect(screen.getByText("This product")).toBeInTheDocument();
    expect(screen.getByText("Median #1.0 · 1 capture")).toBeInTheDocument();
  });

  it("turns provider records into readable labeled fields", () => {
    expect(
      productDetailRows([
        {
          nutrition: { protein_grams: 20 },
          flavors: ["Chocolate", "Vanilla"],
        },
      ]),
    ).toEqual([
      { label: "Nutrition · Protein grams", value: "20" },
      { label: "Flavors", value: "Chocolate, Vanilla" },
    ]);
  });
});
