import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DomainFavicon } from "../src/app/components/domain-favicon";

afterEach(cleanup);

describe("DomainFavicon", () => {
  it("tries both favicon providers before showing a local monogram", () => {
    const { container } = render(
      <DomainFavicon domain="https://www.Example.com/products" size={18} />,
    );

    let image = container.querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      "https://icons.duckduckgo.com/ip3/example.com.ico",
    );

    fireEvent.error(image!);
    image = container.querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      "https://favicon.im/example.com?larger=true&throw-error-on-404=true",
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
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector(".domain-favicon-monogram"))
      .toHaveTextContent("M");

    rerender(<DomainFavicon domain="belki.example" />);

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://icons.duckduckgo.com/ip3/belki.example.ico",
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
