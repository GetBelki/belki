import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppIcon } from "../src/app/components/app-icon";
import { APP_NAME } from "../src/app/lib/branding";

afterEach(cleanup);

describe("Belki branding", () => {
  it("uses the Belki product name", () => {
    expect(APP_NAME).toBe("Belki");
  });

  it("renders the supplied logo as an adaptive decorative mark", () => {
    const { container } = render(<AppIcon className="brand-logo" size={24} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("class", "brand-logo");
    expect(svg).toHaveAttribute("fill", "currentColor");
    expect(svg).toHaveAttribute("height", "24");
    expect(svg).toHaveAttribute("viewBox", "0 0 687.375771 718.597202");
    expect(svg).toHaveAttribute("width", "24");
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });
});
