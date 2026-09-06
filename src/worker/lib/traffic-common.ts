import { z } from "zod";
import { trafficPath } from "../../shared/traffic";
import { ApiError, readBoundedText, RequestBodyTooLargeError, InvalidContentLengthError } from "./http";
export type TrafficEnv = { Bindings: { CONTROL_DB: D1Database }; };
export type SettingsRow = { project_id: string; public_key: string; enabled: number; config_json: string; last_event_at: number | null };
export const SESSION_TIMEOUT = 30 * 60_000;
export const EventSchema = z.object({
  key: z.string().min(20).max(100), id: z.string().uuid(), sessionId: z.string().uuid(), pageId: z.string().uuid(),
  utm: z.string().trim().toLowerCase().min(1).max(100), startedAt: z.number().int().nonnegative(),
  activityAt: z.number().int().nonnegative(), occurredAt: z.number().int().nonnegative(),
  test: z.string().min(20).max(100).optional(), entryPath: trafficPath, path: trafficPath,
  visibleMs: z.number().int().min(0).max(86_400_000), type: z.enum(["page", "event"]),
  event: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(),
}).strict().refine((v) => v.type !== "event" || Boolean(v.event));

export async function body(c: { req: { raw: Request } }, maximum = 16384): Promise<unknown> {
  try { return JSON.parse(await readBoundedText(c.req.raw, maximum)); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw new ApiError(413, "payload_too_large", "Payload too large.");
    if (error instanceof InvalidContentLengthError || error instanceof SyntaxError) throw new ApiError(400, "invalid_body", "Invalid request body.");
    throw error;
  }
}
