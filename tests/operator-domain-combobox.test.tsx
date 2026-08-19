import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
