import { act, render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { TrafficPage } from "../src/app/pages/traffic";
import { api } from "../src/app/lib/api";
import type { TrafficConfig } from "../src/shared/traffic";
vi.mock("../src/app/context", () => ({ useApp: () => ({ projectId: "p1", session: { user: { role: "editor" }, workspace: { status: "active" } }, currentProject: { primary_domain: "example.com" } }) }));
vi.mock("../src/app/lib/api", () => ({ api: vi.fn() }));
const config: TrafficConfig = { key: "public-project-key", enabled: false, domains: ["example.com"], customSources: [], aliases: [], goals: [], lastEvent: null, installation: { mode: "separate", origin: "https://analytics.example", scriptUrl: "https://cdn.example/belki-analytics.js", customScript: true } };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function open(configResponse: Promise<TrafficConfig> = Promise.resolve(config), path = "/ai-traffic") {
  vi.mocked(api).mockImplementation((path, init) => {
    if (path.endsWith("/config")) return Promise.resolve(init?.method === "PUT" ? { ...config, ...(JSON.parse(init.body as string) as Partial<TrafficConfig>) } : configResponse);
    if (path.endsWith("/test")) return Promise.resolve(init?.method === "POST" ? { url: "https://example.com/?belki_test=token", expiresAt: Date.now() + 600000 } : { expiresAt: Date.now() + 600000, result: { path: "/thanks", event: "signup_completed", goals: ["Signup"] } });
    return Promise.resolve({ summary: { sessions: 0, views: 0, visibleMs: 0, converted: 0 }, daily: [], sources: [], entries: [], countries: [], devices: [], pages: [], goals: [] });
  });
  const router = createMemoryRouter([{ path: "/ai-traffic/*", element: <TrafficPage /> }], { initialEntries: [path] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
describe("analytics project setup", () => {
  it("generates the configured CDN tag and lets an editor test before enabling collection", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    await screen.findByText("Your installation tag");
    expect(screen.getByText(/data-api="https:\/\/analytics.example"/).textContent).toContain("https://cdn.example/belki-analytics.js");
    fireEvent.click(screen.getByRole("button", { name: "Create test link" }));
    await screen.findByRole("link", { name: /Open test page/ });
    await screen.findByText("signup_completed");
    expect(api).toHaveBeenCalledWith("/traffic/p1/test", expect.objectContaining({ method: "POST" }));
  });
  it("keeps a conversion draft while changing sections and saves the goal", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Conversions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add goal" }));
    fireEvent.change(screen.getByLabelText("Goal name 1"), { target: { value: "Signup" } });
    fireEvent.change(screen.getByLabelText("Goal type 1"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("Goal value 1"), { target: { value: "signup_completed" } });
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversions" }));
    expect(screen.getByLabelText<HTMLInputElement>("Goal name 1").value).toBe("Signup");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.find(([path, init]) => path === "/traffic/p1/config" && init?.method === "PUT")?.[1]?.body).toContain('"value":"signup_completed"'));
  });
});

describe("analytics sources", () => {
  const savedBodies = () => vi.mocked(api).mock.calls.filter(([path, init]) => path.endsWith("/config") && init?.method === "PUT").map(([, init]) => JSON.parse(init!.body as string) as TrafficConfig);

  it("keeps source details behind Edit and adds aliases inside the focused dialog", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const chatgpt = await screen.findByRole("listitem", { name: "ChatGPT" });
    expect(screen.getByText("6 sources")).toBeInTheDocument();
    expect(within(chatgpt).getByText("4 recognized values")).toBeInTheDocument();
    expect(screen.queryByText("chatgpt.com")).not.toBeInTheDocument();
    fireEvent.click(within(chatgpt).getByRole("button", { name: "Edit ChatGPT" }));
    const editor = screen.getByRole("dialog", { name: "Edit ChatGPT" });
    expect(within(editor).getByText("chatgpt.com")).toBeInTheDocument();
    expect(within(editor).getByText("openai.com")).toBeInTheDocument();
    const alias = within(editor).getByRole("textbox", { name: "Add a UTM value" });
    fireEvent.change(alias, { target: { value: "my-chatgpt-campaign" } });
    fireEvent.keyDown(alias, { key: "Enter" });
    expect(within(editor).getByText("my-chatgpt-campaign")).toBeInTheDocument();
    fireEvent.change(alias, { target: { value: "chatgpt.com" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add alias" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent("already recognized");
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    expect(within(chatgpt).getByText("5 recognized values · 1 project alias")).toBeInTheDocument();
    expect(screen.queryByText("chatgpt.com")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(savedBodies()[0]?.aliases).toEqual([{ alias: "my-chatgpt-campaign", source: "chatgpt" }]));
  });

  it("creates a custom source, attributes more aliases to it and removes it cleanly", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add source" }));
    const dialog = screen.getByRole("dialog", { name: "Add AI source" });
    expect(within(dialog).getByLabelText("Source name")).toHaveAttribute("placeholder", "My AI source");
    expect(within(dialog).getByLabelText("First UTM source")).toHaveAttribute("placeholder", "my-ai-source");
    fireEvent.change(within(dialog).getByLabelText("Source name"), { target: { value: "iAsk" } });
    fireEvent.change(within(dialog).getByLabelText("First UTM source"), { target: { value: "iask.ai" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add source" }));
    const custom = await screen.findByRole("listitem", { name: "iAsk" });
    expect(within(custom).getByText("Custom source")).toBeInTheDocument();
    expect(within(custom).getByText("2 recognized values · 1 project alias")).toBeInTheDocument();
    expect(screen.queryByText("iask.ai")).not.toBeInTheDocument();
    fireEvent.click(within(custom).getByRole("button", { name: "Edit iAsk" }));
    const editor = screen.getByRole("dialog", { name: "Edit iAsk" });
    expect(within(editor).getByText("iask")).toBeInTheDocument();
    expect(within(editor).getByText("iask.ai")).toBeInTheDocument();
    const alias = within(editor).getByRole("textbox", { name: "Add a UTM value" });
    fireEvent.change(alias, { target: { value: "ask-ai" } });
    fireEvent.keyDown(alias, { key: "Enter" });
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(savedBodies()[0]).toMatchObject({
      customSources: [{ id: "iask", label: "iAsk" }],
      aliases: [{ alias: "iask.ai", source: "iask" }, { alias: "ask-ai", source: "iask" }],
    }));
    fireEvent.click(within(custom).getByRole("button", { name: "Edit iAsk" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit iAsk" })).getByRole("button", { name: "Remove source" }));
    expect(screen.queryByRole("listitem", { name: "iAsk" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(savedBodies()[1]).toMatchObject({ customSources: [], aliases: [] }));
  });
});

describe("analytics date range", () => {
  it("applies custom dates together and preserves them when a later edit is cancelled", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Date range \(UTC\)/ }));
    const before = vi.mocked(api).mock.calls.filter(([path]) => path.includes("/report?")).length;
    fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2020-04-01" } });
    fireEvent.change(screen.getByLabelText("To (UTC)"), { target: { value: "2020-04-09" } });
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes("/report?"))).toHaveLength(before);
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/traffic/p1/report?from=2020-04-01&to=2020-04-09"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Date range \(UTC\)/ }));
    fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2020-04-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /Date range \(UTC\)/ }));
    expect(screen.getByLabelText("From (UTC)")).toHaveValue("2020-04-01");
  });
  it("selects an inclusive seven-day range ending today in UTC", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Date range \(UTC\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10);
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/traffic/p1/report?from=${from}&to=${today}`));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps incomplete or overly long custom ranges from being applied", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Date range \(UTC\)/ }));
    fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Apply dates" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2000-01-01" } });
    expect(screen.getByRole("button", { name: "Apply dates" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("no more than 12 months");
  });
});

function deferredConfig() {
  let resolve!: (value: TrafficConfig) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<TrafficConfig>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

describe("analytics initial section", () => {
  it("exposes direct section routes and keeps browser history in sync", async () => {
    const router = open(Promise.resolve(config), "/ai-traffic/sources");
    await screen.findByText("Recognized sources");
    expect(screen.getByRole("button", { name: "Sources" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    await screen.findByText("Install Belki Analytics");
    expect(router.state.location.pathname).toBe("/ai-traffic/installation");
    fireEvent.click(screen.getByRole("button", { name: "Conversions" }));
    await screen.findByRole("button", { name: "Add goal" });
    expect(router.state.location.pathname).toBe("/ai-traffic/conversions");
    await act(() => router.navigate(-1));
    await screen.findByText("Install Belki Analytics");
    expect(screen.getByRole("button", { name: "Installation" })).toHaveAttribute("aria-pressed", "true");
  });

  it("waits for settings before selecting Overview for an installed project", async () => {
    const pending = deferredConfig();
    open(pending.promise);
    expect(screen.getByRole("button", { name: "Installation" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Install Belki Analytics")).not.toBeInTheDocument();
    await act(() => { pending.resolve(config); return pending.promise; });
    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Installation" })).toHaveAttribute("aria-pressed", "false");
  });
  it("selects Installation only after confirming that a project has no key", async () => {
    const pending = deferredConfig();
    open(pending.promise);
    expect(screen.getByRole("button", { name: "Installation" })).toHaveAttribute("aria-pressed", "false");
    await act(() => { pending.resolve({ ...config, key: null }); return pending.promise; });
    await screen.findByText("Install Belki Analytics");
    expect(screen.getByRole("button", { name: "Installation" })).toHaveAttribute("aria-pressed", "true");
  });
  it("preserves a section chosen while settings are loading", async () => {
    const pending = deferredConfig();
    open(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Conversions" }));
    await act(() => { pending.resolve(config); return pending.promise; });
    await screen.findByRole("button", { name: "Add goal" });
    expect(screen.getByRole("button", { name: "Conversions" })).toHaveAttribute("aria-pressed", "true");
  });
  it("does not mistake a failed settings request for a missing installation", async () => {
    const pending = deferredConfig();
    open(pending.promise);
    await act(() => { pending.reject(new Error("Settings unavailable")); return pending.promise.catch(() => undefined); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings unavailable");
    expect(screen.getByRole("button", { name: "Installation" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("analytics copy actions", () => {
  it("copies the complete tag and resets confirmation two seconds after each copy", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    const code = await screen.findByLabelText("Installation tag");
    vi.useFakeTimers();
    await act(() => { fireEvent.click(screen.getByRole("button", { name: "Copy tag" })); return Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(code.textContent);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1500); });
    await act(() => { fireEvent.click(screen.getByRole("button", { name: "Copied" })); return Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole("button", { name: "Copy tag" })).toBeInTheDocument();
  });
  it("shows the generated test URL and copies that exact link", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create test link" }));
    const field = await screen.findByRole("textbox", { name: "Test link" });
    expect(field).toHaveValue("https://example.com/?belki_test=token");
    expect(field).toHaveAttribute("readonly");
    expect(screen.getByRole("link", { name: "Open test page" })).toHaveAttribute("href", "https://example.com/?belki_test=token");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("https://example.com/?belki_test=token");
  });
  it("reports a clipboard failure without claiming success and allows retry", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined).mockRejectedValueOnce(new Error("Permission denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy tag" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t copy");
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy tag" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});


describe("analytics hostname tags", () => {
  async function hostnames(value = config) {
    open(Promise.resolve(value));
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    return screen.findByRole("textbox", { name: "Authorized hostnames" });
  }
  const savedBodies = () => vi.mocked(api).mock.calls.filter(([path, init]) => path.endsWith("/config") && init?.method === "PUT").map(([, init]) => JSON.parse(init!.body as string) as TrafficConfig);

  it("adds normalized tags with Enter, skips duplicates and removes a tag", async () => {
    const input = await hostnames();
    fireEvent.change(input, { target: { value: "WWW.Example.COM" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove www.example.com" })).toBeInTheDocument();
    expect(savedBodies()).toHaveLength(0);
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "WWW.EXAMPLE.COM" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getAllByRole("button", { name: "Remove www.example.com" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }));
    expect(screen.queryByRole("button", { name: "Remove example.com" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(savedBodies()[0]?.domains).toEqual(["www.example.com"]));
  });
  it("pastes multiple hosts and preserves an unfinished hostname across sections and save", async () => {
    const input = await hostnames();
    fireEvent.paste(input, { clipboardData: { getData: () => "blog.example.com, WWW.EXAMPLE.COM\nexample.com" } });
    expect(screen.getByRole("button", { name: "Remove blog.example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove www.example.com" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "shop.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Conversions" }));
    fireEvent.click(screen.getByRole("button", { name: "Installation" }));
    expect(screen.getByRole("textbox", { name: "Authorized hostnames" })).toHaveValue("shop.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(savedBodies()[0]?.domains).toEqual(["example.com", "blog.example.com", "www.example.com", "shop.example.com"]));
  });
  it("keeps invalid pasted text for correction and prevents saving from another section", async () => {
    const input = await hostnames();
    const pasted = "valid.example.com, https://wrong.example.com/path";
    fireEvent.paste(input, { clipboardData: { getData: () => pasted } });
    expect(input).toHaveValue(pasted);
    expect(screen.getByRole("alert")).toHaveTextContent("not a valid hostname");
    expect(screen.queryByRole("button", { name: "Remove valid.example.com" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Check the Installation section");
    expect(savedBodies()).toHaveLength(0);
  });
  it("enforces the host limit and rejects saving an empty list", async () => {
    const domains = Array.from({ length: 20 }, (_, i) => `site${i}.example.com`);
    const input = await hostnames({ ...config, domains });
    fireEvent.change(input, { target: { value: "extra.example.com" } });
    fireEvent.keyDown(input, { key: "," });
    expect(screen.getByRole("alert")).toHaveTextContent("up to 20");
    expect(input).toHaveValue("extra.example.com");
    fireEvent.change(input, { target: { value: "" } });
    for (const domain of domains) fireEvent.click(screen.getByRole("button", { name: `Remove ${domain}` }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least one");
    expect(savedBodies()).toHaveLength(0);
  });
});
