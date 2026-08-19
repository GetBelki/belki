import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insightYAxisMax } from "../src/app/lib/chart-scale";
import { CitationDomainCombobox } from "../src/app/pages/operator-insights";

class ResizeObserverMock {
  disconnect() {}
  observe() {}
  unobserve() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(cleanup);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("citation domain combobox", () => {
  it("searches inside the popup and applies a domain immediately", async () => {
    const options = [
      { label: "All cited domains", value: "" },
      { label: "reddit.com", value: "reddit.com" },
      { label: "example.com", value: "example.com" },
    ];
    const onSearchChange = vi.fn();
    const onValueChange = vi.fn();

    render(
      <CitationDomainCombobox
        isFetching={false}
        onSearchChange={onSearchChange}
        onValueChange={onValueChange}
        options={options}
        searchValue=""
        value={options[0]!}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Cited domain" }));
    const search = await screen.findByRole("combobox", {
      name: "Search cited domains",
    });
    fireEvent.change(search, { target: { value: "redd" } });

    expect(onSearchChange).toHaveBeenLastCalledWith("redd");
    fireEvent.click(await screen.findByRole("option", { name: "reddit.com" }));
    expect(onValueChange).toHaveBeenCalledWith(
      options[1],
      expect.any(Object),
    );
  });
});

describe("operator insight chart scale", () => {
  it("adds useful headroom while preserving the zero baseline", () => {
    expect(insightYAxisMax([0.1, 0.4])).toBe(1);
    expect(insightYAxisMax([1.2, 3.9])).toBe(5);
    expect(insightYAxisMax([4, 9.8])).toBe(15);
    expect(insightYAxisMax([25])).toBe(30);
    expect(insightYAxisMax([42])).toBe(50);
    expect(insightYAxisMax([100])).toBe(100);
  });
});
