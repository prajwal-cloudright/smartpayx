/**
 * GET /pay/payu?d=<token> — hands the buyer's browser to PayU.
 *
 * PayU's checkout only accepts a browser form POST, but our adapter contract
 * returns a URL to navigate to. This route bridges the two: it renders a page
 * that immediately auto-submits the signed fields to PayU.
 *
 * Safe to be public and stateless: the token holds no secret (the hash is a
 * one-way SHA-512 including the merchant salt), tampering with any field
 * invalidates the hash so PayU rejects it, and the destination is picked from
 * a fixed allowlist (live/test) — never taken from the token — so this can't
 * be used as an open redirect.
 */
import type { LoaderFunctionArgs } from "react-router";
import {
  decodePayuFormToken,
  payuPaymentUrl,
} from "../services/pg/payu.server";

const escapeHtml = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("d") ?? "";
  const decoded = decodePayuFormToken(token);
  if (!decoded) return new Response("Invalid payment link.", { status: 400 });

  const inputs = Object.entries(decoded.fields)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Redirecting to PayU…</title></head>
<body onload="document.getElementById('payu').submit()" style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px">
<p>Redirecting you to PayU secure checkout…</p>
<form id="payu" method="POST" action="${payuPaymentUrl(decoded.env)}">${inputs}
<noscript><button type="submit">Continue to PayU</button></noscript></form>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
