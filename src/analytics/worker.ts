import { Hono } from "hono";
import { trafficPublicRoutes } from "../worker/routes/traffic-public";
import { errorResponse } from "../worker/lib/http";
import type { TrafficEnv } from "../worker/lib/traffic-common";

// No application auth, billing, queues, secrets or dashboard routes in this Worker.
const app = new Hono<TrafficEnv>();
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  await next();
});
app.onError((error, c) => errorResponse(c, error));
app.route("/", trafficPublicRoutes);
export default app;
