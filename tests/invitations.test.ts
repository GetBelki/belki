import { describe, expect, it } from "vitest";
import {
  WORKSPACE_INVITATION_TTL_DAYS,
  workspaceInvitationExpiresAt,
} from "../src/shared/invitations";

describe("workspace invitations", () => {
  it("expires invitations seven days after creation", () => {
    const createdAt = Date.parse("2026-08-21T12:00:00.000Z");

    expect(WORKSPACE_INVITATION_TTL_DAYS).toBe(7);
    expect(workspaceInvitationExpiresAt(createdAt)).toBe("2026-08-28T12:00:00.000Z");
  });
});
