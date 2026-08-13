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
    const logo = container.querySelector("img");

    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveAttribute("class", "app-icon brand-logo");
    expect(logo).toHaveAttribute("height", "24");
    expect(logo).toHaveAttribute("src", "/belki-logo.svg");
    expect(logo).toHaveAttribute("width", "24");
  });
});
