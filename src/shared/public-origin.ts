const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizePublicAppOrigin(value: string): string {
  const input = value.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid public application URL.");
  }

  const localHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("The public application URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("The public application URL cannot contain credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter an origin only, without a path, query, or fragment.");
  }
  return url.origin;
}
