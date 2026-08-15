import { describe, expect, it, vi } from "vitest";
import {
  createInvitationEmail,
  createPasswordResetEmail,
  sendTransactionalEmail,
} from "../src/worker/lib/email";

describe("transactional email", () => {
  it("creates text and escaped HTML invitation bodies", () => {
    const message = createInvitationEmail({
      appName: "Belki",
      inviteeEmail: "invitee@example.com",
      inviterName: "Ada <Admin>",
      workspaceName: "Research &\nGrowth",
      role: "editor",
      link: "https://app.example.com/accept-invite?token=abc&source=email",
      expiresAt: "2026-08-14T12:00:00.000Z",
    });

    expect(message.subject).toBe("Ada <Admin> invited you to Research & Growth");
    expect(message.text).toContain("as Editor");
    expect(message.text).toContain("https://app.example.com/accept-invite?token=abc&source=email");
    expect(message.html).toContain("Ada &lt;Admin&gt;");
    expect(message.html).toContain("Research &amp;\nGrowth");
    expect(message.html).toContain("token=abc&amp;source=email");
    expect(message.html).not.toContain("Ada <Admin>");
  });

  it("sends both text and HTML through the Cloudflare binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "message-123" });
    const email = { send };
    const result = await sendTransactionalEmail(
      email,
      { email: "noreply@notifications.getbelki.com", name: "Belki" },
      {
        to: "invitee@example.com",
        subject: "Invitation",
        text: "Accept the invitation",
        html: "<p>Accept the invitation</p>",
      },
    );

    expect(result).toEqual({ messageId: "message-123" });
    expect(send).toHaveBeenCalledWith({
      to: "invitee@example.com",
      from: { email: "noreply@notifications.getbelki.com", name: "Belki" },
      subject: "Invitation",
      text: "Accept the invitation",
      html: "<p>Accept the invitation</p>",
    });
  });

  it("creates a bounded password reset message without exposing secrets", () => {
    const message = createPasswordResetEmail({
      appName: "Belki",
      email: "owner@example.com",
      link: "https://app.example.com/reset-password?token=abc&next=%3Cdashboard%3E",
      expiresAt: "2026-08-14T13:00:00.000Z",
    });
    expect(message.subject).toBe("Reset your Belki password");
    expect(message.text).toContain("reset-password?token=abc");
    expect(message.html).toContain("token=abc&amp;next=%3Cdashboard%3E");
  });
});
