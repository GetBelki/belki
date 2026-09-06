import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TrafficPage } from "../src/app/pages/traffic";
import { api } from "../src/app/lib/api";
import type { TrafficConfig } from "../src/shared/traffic";
vi.mock("../src/app/context", () => ({ useApp: () => ({ projectId: "p1", session: { user: { role: "editor" }, workspace: { status: "active" } }, currentProject: { primary_domain: "example.com" } }) }));
vi.mock("../src/app/lib/api", () => ({ api: vi.fn() }));
const config: TrafficConfig = { key: "public-project-key", enabled: false, domains: ["example.com"], aliases: [], goals: [], lastEvent: null, installation: { mode: "separate", origin: "https://analytics.example", scriptUrl: "https://cdn.example/belki-analytics.js", customScript: true } };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function open() {
  vi.mocked(api).mockImplementation((path, init) => {
    if (path.endsWith("/config")) return Promise.resolve(init?.method === "PUT" ? { ...config, ...(JSON.parse(init.body as string) as Partial<TrafficConfig>) } : config);
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
