const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const WORKSPACE_INVITATION_TTL_DAYS = 7;

export function workspaceInvitationExpiresAt(now = Date.now()): string {
  return new Date(
    now + WORKSPACE_INVITATION_TTL_DAYS * MILLISECONDS_PER_DAY,
  ).toISOString();
}
