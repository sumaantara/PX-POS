// PX POS — daily sales email.
//   • Scheduled: pg_cron calls this every hour with header x-cron-key (see migration 0004). It sends once a day,
//     at Settings → report_hour (WITA), when report_enabled is on.
//   • Manual: an owner/admin presses "Send now" in the back office (Authorization: Bearer <user session>).
// Verify JWT: OFF (this function authenticates callers itself).
// Secrets (Edge Functions → Secrets), same as the HRM project: SMTP_HOST, SMTP_PORT (465/587), SMTP_USER, SMTP_PASS, SMTP_FROM
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const rp = (n: unknown) => "Rp " + Math.round(Number(n) || 0).toLocaleString("en-US");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TZ_OFFSET_H = 8; // WITA (Asia/Makassar), no DST

const wita = (d = new Date()) => new Date(d.getTime() + TZ_OFFSET_H * 3600e3);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const env = (k: string) => Deno.env.get(k) || "";
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));

  // ── who is calling? ──
  let kind: "scheduled" | "manual" = "manual";
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    const { data: okKey } = await admin.rpc("px_check_cron_key", { k: cronKey });
    if (okKey !== true) return json(401, { error: "Bad scheduler key" });
    kind = "scheduled";
  } else {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json(401, { error: "Please sign in" });
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", u.user.id).single();
    if (!me?.active || !["owner", "admin"].includes(me.role)) return json(403, { error: "Owners and admins only" });
  }

  const { data: st, error: se } = await admin.from("settings").select("*").eq("id", 1).single();
  if (se || !st) return json(500, { error: "Settings not found" });

  const now = wita();
  let day = isoDay(now);
  if (kind === "scheduled") {
    if (!st.report_enabled) return json(200, { skipped: "disabled" });
    if (now.getUTCHours() !== Number(st.report_hour)) return json(200, { skipped: "not the time", hour: now.getUTCHours() });
    const { count } = await admin.from("report_log").select("id", { count: "exact", head: true }).eq("day", day).eq("kind", "scheduled").eq("ok", true);
    if ((count ?? 0) > 0) return json(200, { skipped: "already sent" });
  } else if (typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day)) {
    day = body.day;
  }

  const recipients: string[] = (st.report_emails || []).map((e: string) => String(e).trim().toLowerCase()).filter((e: string) => EMAIL.test(e)).slice(0, 20);
  if (!recipients.length) return json(400, { error: "Add at least one recipient email in Settings → Daily email" });

  const host = env("SMTP_HOST"), user = env("SMTP_USER"), pass = env("SMTP_PASS");
  if (!host || !user || !pass) {
    await admin.from("report_log").insert({ day, kind, recipients, ok: false, error: "SMTP secrets missing" });
    return json(503, { error: "Email is not set up yet: add the SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM secrets to the daily-report function." });
  }

  // ── data ──
  const { data: rep, error: re } = await admin.rpc("sales_report", { p_from: day, p_to: day });
  if (re) return json(500, { error: re.message });
  const from = new Date(new Date(day + "T00:00:00Z").getTime() - TZ_OFFSET_H * 3600e3).toISOString();
  const to = new Date(new Date(day + "T00:00:00Z").getTime() + (24 - TZ_OFFSET_H) * 3600e3).toISOString();
  const { data: txs } = await admin.from("transactions")
    .select("receipt_no, created_at, customer_name, payment_method, total, status, void_reason, cashier:profiles!transactions_cashier_id_fkey(full_name), items:transaction_items(name, qty, item_ref)")
    .gte("created_at", from).lt("created_at", to).order("created_at").limit(500);
  const { data: cats } = await admin.from("categories").select("code,name,icon");
  const catName = (c: string) => { const x = (cats || []).find((k) => k.code === c); return x ? `${x.icon} ${x.name}` : c; };
  const { count: rentalsOut } = await admin.from("transaction_items").select("id", { count: "exact", head: true }).eq("rental_status", "out");

  // ── email ──
  const prettyDay = new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const biz = st.business_name || "PX";
  const kpi = (label: string, value: string) => `<td style="padding:12px 14px;background:#f1f7f6;border-radius:10px;width:33%"><div style="font-size:12px;color:#5d6f6d">${esc(label)}</div><div style="font-size:19px;font-weight:700;color:#0f1f1e;margin-top:2px">${esc(value)}</div></td>`;
  const table = (title: string, head: string[], rows: string[][]) => !rows.length ? "" : `
    <h3 style="margin:22px 0 8px;font-size:15px;color:#0f1f1e">${esc(title)}</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <tr>${head.map((h, i) => `<th style="text-align:${i ? "right" : "left"};padding:6px 4px;border-bottom:1px solid #dfe7e6;color:#5d6f6d;font-weight:600">${esc(h)}</th>`).join("")}</tr>
      ${rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i ? "right" : "left"};padding:7px 4px;border-bottom:1px solid #eef2f1;color:#0f1f1e">${c}</td>`).join("")}</tr>`).join("")}
    </table>`;
  const r = rep as Record<string, any>;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f1f1e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 10px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #dfe7e6">
<tr><td style="background:#0f766e;padding:18px 24px;color:#fff">
  <div style="font-size:13px;opacity:.85">${esc(biz)} · Daily sales report</div>
  <div style="font-size:21px;font-weight:700;margin-top:2px">${esc(prettyDay)}</div></td></tr>
<tr><td style="padding:20px 24px 26px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>${kpi("Net sales", rp(r.total))}${kpi("Transactions", String(r.count))}${kpi("Average sale", rp(r.count ? r.total / r.count : 0))}</tr>
  <tr>${kpi("Gross", rp(r.gross))}${kpi("Discounts", rp(r.discount))}${kpi(`${st.service_label || "Service"} + ${st.tax_label || "Tax"}`, rp(Number(r.service) + Number(r.tax)))}</tr></table>
  ${Number(r.card_fee) ? `<p style="margin:12px 4px 0;font-size:13px;color:#5d6f6d">Includes ${esc(st.card_fee_label || "Card fee")}: <b>${rp(r.card_fee)}</b></p>` : ""}
  ${Number(r.void_count) ? `<p style="margin:12px 4px 0;font-size:13px;color:#dc2626">${r.void_count} voided sale(s) worth ${rp(r.void_total)} are excluded.</p>` : ""}
  ${table("By category", ["Category", "Qty", "Sales"], (r.by_category || []).map((x: any) => [esc(catName(x.category)), esc(Number(x.qty).toLocaleString("en-US")), rp(x.total)]))}
  ${table("By service", ["Service", "Qty", "Sales"], (r.by_service || []).map((x: any) => [esc(x.name), esc(Number(x.qty).toLocaleString("en-US")), rp(x.total)]))}
  ${table("By payment method", ["Method", "Sales count", "Amount"], (r.by_method || []).map((x: any) => [esc(x.method), String(x.count), rp(x.total)]))}
  ${table("By cashier", ["Cashier", "Sales count", "Amount"], (r.by_cashier || []).map((x: any) => [esc(x.cashier), String(x.count), rp(x.total)]))}
  ${table("Transactions", ["Receipt · time · guest", "Method", "Total"], (txs || []).map((t: any) => [
      `<b>${esc(t.receipt_no)}</b> · ${esc(new Date(new Date(t.created_at).getTime() + TZ_OFFSET_H * 3600e3).toISOString().slice(11, 16))} · ${esc(t.customer_name || "Guest")}<br><span style="color:#5d6f6d">${esc((t.items || []).map((i: any) => `${i.name}${Number(i.qty) !== 1 ? " ×" + Number(i.qty) : ""}${i.item_ref ? " (" + i.item_ref + ")" : ""}`).join(", "))}${t.status === "void" ? ` · <span style="color:#dc2626">VOID: ${esc(t.void_reason)}</span>` : ""}</span>`,
      esc(t.payment_method), t.status === "void" ? `<s style="color:#5d6f6d">${rp(t.total)}</s>` : rp(t.total)]))}
  ${!r.count ? `<p style="margin:20px 4px 0;color:#5d6f6d">No sales were recorded on this day.</p>` : ""}
  <p style="margin:20px 4px 0;font-size:13px;color:#5d6f6d">Bikes / e-bikes still out right now: <b>${rentalsOut ?? 0}</b></p>
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #dfe7e6;font-size:12px;color:#5d6f6d">Sent automatically by PX POS${kind === "manual" ? " (requested from the back office)" : ""}. Change recipients or the time in Back office → Settings → Daily email.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`${biz} — Daily sales report — ${prettyDay}`, "", `Net sales: ${rp(r.total)}`, `Transactions: ${r.count}`, `Gross: ${rp(r.gross)}  Discounts: ${rp(r.discount)}  Service: ${rp(r.service)}  Tax: ${rp(r.tax)}  ${st.card_fee_label || "Card fee"}: ${rp(r.card_fee)}`,
    Number(r.void_count) ? `Voided: ${r.void_count} (${rp(r.void_total)})` : "", "", "By payment method:", ...(r.by_method || []).map((x: any) => `  ${x.method}: ${rp(x.total)} (${x.count})`),
    "", "By service:", ...(r.by_service || []).map((x: any) => `  ${x.name} x${x.qty}: ${rp(x.total)}`)].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");

  try {
    const port = Number(env("SMTP_PORT") || 465);
    const tx = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await tx.sendMail({ from: env("SMTP_FROM") || user, to: recipients.join(", "), subject: `${biz} — Sales ${day}: ${rp(r.total)} (${r.count} sales)`, html, text });
    await admin.from("report_log").insert({ day, kind, recipients, ok: true });
    return json(200, { ok: true, day, recipients });
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    await admin.from("report_log").insert({ day, kind, recipients, ok: false, error: msg });
    return json(502, { error: "Sending failed: " + msg });
  }
});
