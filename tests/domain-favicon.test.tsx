import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DomainFavicon } from "../src/app/components/domain-favicon";

afterEach(cleanup);

describe("DomainFavicon", () => {
  it("uses the status-checked favicon endpoint before a local monogram", () => {
    const { container } = render(
      <DomainFavicon domain="https://www.Example.com/products" size={18} />,
    );

    const image = container.querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      "/api/v1/favicon?domain=example.com&v=2",
    );

    fireEvent.error(image!);
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector(".domain-favicon-monogram"))
      .toHaveTextContent("E");
  });

  it("starts from the first provider after the domain changes", () => {
    const { container, rerender } = render(
      <DomainFavicon domain="missing.example" />,
    );

    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector(".domain-favicon-monogram"))
      .toHaveTextContent("M");

    rerender(<DomainFavicon domain="belki.example" />);

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/v1/favicon?domain=belki.example&v=2",
    );
  });

  it("keeps the generic globe when no valid domain exists", () => {
    const { container } = render(<DomainFavicon domain="not a domain" />);

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector(".domain-favicon-monogram"))
      .not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
