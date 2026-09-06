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
