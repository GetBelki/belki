export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface TransactionalEmailSender {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId: string }>;
}

export interface InvitationEmailInput {
  appName: string;
  inviteeEmail: string;
  inviterName: string;
  workspaceName: string;
  role: "admin" | "editor" | "viewer";
  link: string;
  expiresAt: string;
}

export interface PasswordResetEmailInput {
  appName: string;
  email: string;
  link: string;
  expiresAt: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleLabel(role: InvitationEmailInput["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function headerText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function createInvitationEmail(input: InvitationEmailInput): TransactionalEmail {
  const role = roleLabel(input.role);
  const expiration = new Date(input.expiresAt).toUTCString();
  const subject = `${headerText(input.inviterName)} invited you to ${headerText(input.workspaceName)}`;
  const text = [
    `${input.inviterName} invited you to join ${input.workspaceName} in ${input.appName} as ${role}.`,
    "",
    `Accept your invitation: ${input.link}`,
    "",
    `This invitation expires ${expiration}. If you were not expecting it, you can ignore this email.`,
  ].join("\n");

  const appName = escapeHtml(input.appName);
  const inviterName = escapeHtml(input.inviterName);
  const workspaceName = escapeHtml(input.workspaceName);
  const inviteeEmail = escapeHtml(input.inviteeEmail);
  const link = escapeHtml(input.link);

  return {
    to: input.inviteeEmail,
    subject,
    text,
    html: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="background:#f4f4f5;color:#27272a;font-family:Arial,sans-serif;margin:0;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;margin:0 auto;max-width:560px;padding:32px">
      <p style="color:#71717a;font-size:13px;font-weight:700;margin:0 0 24px">${appName}</p>
      <h1 style="font-size:24px;line-height:1.25;margin:0 0 16px">Join ${workspaceName}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px">${inviterName} invited ${inviteeEmail} to join this workspace as ${role}.</p>
      <p style="margin:0 0 24px"><a href="${link}" style="background:#18181b;border-radius:7px;color:#fff;display:inline-block;font-size:14px;font-weight:700;padding:12px 18px;text-decoration:none">Accept invitation</a></p>
      <p style="color:#71717a;font-size:12px;line-height:1.6;margin:0">This invitation expires ${escapeHtml(expiration)}. If you were not expecting it, you can ignore this email.</p>
    </div>
  </body>
</html>`,
  };
}

export function sendTransactionalEmail(
  email: TransactionalEmailSender,
  from: { email: string; name: string },
  message: TransactionalEmail,
): Promise<{ messageId: string }> {
  return email.send({
    to: message.to,
    from,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

export function sendInvitationEmail(
  email: TransactionalEmailSender,
  from: { email: string; name: string },
  input: InvitationEmailInput,
): Promise<{ messageId: string }> {
  return sendTransactionalEmail(email, from, createInvitationEmail(input));
}

export function createPasswordResetEmail(input: PasswordResetEmailInput): TransactionalEmail {
  const expiration = new Date(input.expiresAt).toUTCString();
  const subject = `Reset your ${headerText(input.appName)} password`;
  const text = [
    `A password reset was requested for your ${input.appName} account.`,
    "",
    `Choose a new password: ${input.link}`,
    "",
    `This link expires ${expiration}. If you did not request it, you can ignore this email.`,
  ].join("\n");
  return {
    to: input.email,
    subject,
    text,
    html: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="background:#f4f4f5;color:#27272a;font-family:Arial,sans-serif;margin:0;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;margin:0 auto;max-width:560px;padding:32px">
      <p style="color:#71717a;font-size:13px;font-weight:700;margin:0 0 24px">${escapeHtml(input.appName)}</p>
      <h1 style="font-size:24px;line-height:1.25;margin:0 0 16px">Reset your password</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px">Use the button below to choose a new password.</p>
      <p style="margin:0 0 24px"><a href="${escapeHtml(input.link)}" style="background:#18181b;border-radius:7px;color:#fff;display:inline-block;font-size:14px;font-weight:700;padding:12px 18px;text-decoration:none">Choose new password</a></p>
      <p style="color:#71717a;font-size:12px;line-height:1.6;margin:0">This link expires ${escapeHtml(expiration)}. If you did not request it, you can ignore this email.</p>
    </div>
  </body>
</html>`,
  };
}

export function sendPasswordResetEmail(
  email: TransactionalEmailSender,
  from: { email: string; name: string },
  input: PasswordResetEmailInput,
): Promise<{ messageId: string }> {
  return sendTransactionalEmail(email, from, createPasswordResetEmail(input));
}
