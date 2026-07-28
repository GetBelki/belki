import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownAnswer } from "../src/app/components/markdown-answer";

afterEach(cleanup);

describe("MarkdownAnswer", () => {
  it("renders provider Markdown as structured, safe content", () => {
    render(
      <MarkdownAnswer
        markdown={[
          "### Recommendations",
          "",
          "- **Royal Canin** for picky cats",
          "- [Zooplus](https://www.zooplus.de/product?utm_source=chatgpt)",
          "",
          "| Product | Rating |",
          "| --- | --- |",
          "| Royal Canin | 4.8 |",
        ].join("\n")}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Recommendations", level: 3 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Royal Canin", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zooplus" })).toHaveAttribute(
      "href",
      "https://www.zooplus.de/product?utm_source=chatgpt",
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("does not create executable or relative links from captured content", () => {
    render(
      <MarkdownAnswer markdown="[Unsafe](javascript:alert(1)) [Relative](/admin)" />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Unsafe")).toBeInTheDocument();
    expect(screen.getByText("Relative")).toBeInTheDocument();
  });
});
