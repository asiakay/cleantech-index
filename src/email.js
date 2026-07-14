// email.js — thin wrapper around the Resend REST API.
// Requires env.RESEND_API_KEY (set via `wrangler secret put RESEND_API_KEY`).
// Requires env.EMAIL_FROM — e.g. "CleanTech Index <noreply@yourdomain.com>"

export async function sendMagicLink(env, { to, magicUrl }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");

  // onboarding@resend.dev is Resend's pre-verified shared sender — works with any API key
  // without domain setup. Set EMAIL_FROM to an address on your own verified domain in prod.
  const from = env.EMAIL_FROM || "CleanTech Index <onboarding@resend.dev>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your CleanTech Index sign-in link",
      html: `
        <p>Click the link below to sign in to CleanTech Index. It expires in 15 minutes.</p>
        <p><a href="${magicUrl}" style="font-size:16px;font-weight:bold">${magicUrl}</a></p>
        <p style="color:#666;font-size:12px">If you didn't request this, you can safely ignore it.</p>
      `,
      text: `Sign in to CleanTech Index:\n\n${magicUrl}\n\nThis link expires in 15 minutes. If you didn't request this, ignore it.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}
