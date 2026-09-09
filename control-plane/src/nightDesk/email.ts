export async function sendNightDeskEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  try {
    const nodemailer = await import("nodemailer");
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST || "localhost",
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || "",
          }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "noreply@veralux.ai",
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.text
        .split("\n")
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join(""),
    });
    return true;
  } catch (error) {
    console.error(
      "[nightDesk/email] send failed",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
