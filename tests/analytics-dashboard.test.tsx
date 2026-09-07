import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TrafficPage } from "../src/app/pages/traffic";
import { api } from "../src/app/lib/api";
import type { TrafficConfig } from "../src/shared/traffic";
vi.mock("../src/app/context", () => ({ useApp: () => ({ projectId: "p1", session: { user: { role: "editor" }, workspace: { status: "active" } }, currentProject: { primary_domain: "example.com" } }) }));
vi.mock("../src/app/lib/api", () => ({ api: vi.fn() }));
const config: TrafficConfig = { key: "public-project-key", enabled: false, domains: ["example.com"], aliases: [], goals: [], lastEvent: null, installation: { mode: "separate", origin: "https://analytics.example", scriptUrl: "https://cdn.example/belki-analytics.js", customScript: true } };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function open(configResponse: Promise<TrafficConfig> = Promise.resolve(config)) {
  vi.mocked(api).mockImplementation((path, init) => {
    if (path.endsWith("/config")) return Promise.resolve(init?.method === "PUT" ? { ...config, ...(JSON.parse(init.body as string) as Partial<TrafficConfig>) } : configResponse);
    if (path.endsWith("/test")) return Promise.resolve(init?.method === "POST" ? { url: "https://example.com/?belki_test=token", expiresAt: Date.now() + 600000 } : { expiresAt: Date.now() + 600000, result: { path: "/thanks", event: "signup_completed", goals: ["Signup"] } });
    return Promise.resolve({ summary: { sessions: 0, views: 0, visibleMs: 0, converted: 0 }, daily: [], sources: [], entries: [], countries: [], devices: [], pages: [], goals: [] });
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TrafficPage /></QueryClientProvider>);
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
