/* PX POS — one codebase, two apps:
 *   • Android app (Capacitor)  → Cashier: sale, history, rentals, shift, printer
 *   • Website (GitHub Pages)   → Back office: dashboard, reports, transactions, rentals, shifts, services, users, settings
 * Data and permissions live in Supabase (Row Level Security + server functions). */
(function () {
  "use strict";
  const C = window.PX_CONFIG, P = window.PXPrinter;
  const MODE = window.PX_FORCE_MODE || (P.isNative() ? "cashier" : "backoffice");
  const BO = MODE === "backoffice";
  document.documentElement.classList.add(BO ? "mode-bo" : "mode-cashier");
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // ───────────────────────── helpers ─────────────────────────
  function pad(n) { return String(n).padStart(2, "0"); }
  function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function today() { return isoOf(new Date()); }
  function monthStart() { const d = new Date(); d.setDate(1); return isoOf(d); }
  function addDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoOf(d); }
  const $ = (s, r = document) => r.querySelector(s);
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rp = (n) => P.rupiah(n);
  const num = (v) => { const n = Number(String(v ?? "").replace(/[^\d]/g, "")); return isFinite(n) ? n : 0; };            // money (whole rupiah)
  const dec = (v) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; }; // qty, %, hours
  const dayStartISO = (iso) => new Date(iso + "T00:00:00").toISOString();
  const dayEndISO = (iso) => new Date(addDays(iso, 1) + "T00:00:00").toISOString();
  const fmtDT = (d) => P.fmtDT(d);
  const fmtT = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
  const fmtD = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const isAdmin = () => S.profile && ["owner", "admin"].includes(S.profile.role) && S.profile.active;
  const catOf = (code) => S.cats.find((c) => c.code === code) || { name: code, icon: "🛎️", color: "#0f766e", is_rental: false };
  const unitL = (u, q = 1) => P.unitLabel(u, q);
  const REF_HINT = { rent_bike: "Bike no.", ebike: "E-bike no.", massage: "Therapist", snorkeling: "Guide / no. of guests", laundry: "Laundry tag no." };
  const ROLE = { owner: "Owner", admin: "Admin", cashier: "Cashier" };
  const errMsg = (e) => { const m = (e && (e.message || e.error_description || e.error)) || String(e); return m.replace(/^.*?ERROR:\s*/, ""); };

  // ───────────────────────── state ─────────────────────────
  const S = {
    session: null, profile: null, settings: null, cats: [], services: [],
    view: BO ? "dash" : "pos", cat: "all", cart: [], cust: { name: "", phone: "", note: "" },
    disc: { mode: "rp", v: "" }, pay: { method: "Cash", paid: "" }, cartOpen: false,
    shift: undefined, busy: false, authMode: "login",
    tx: { from: BO ? today() : addDays(today(), -1), to: today(), q: "", rows: null },
    rentals: null, shifts: null, users: null, dash: null, reportLog: null,
    rep: { from: monthStart(), to: today(), data: null },
  };

  function toast(msg, bad) {
    const el = document.createElement("div");
    el.className = "tm" + (bad ? " bad" : ""); el.textContent = msg;
    const box = $("#toast"); while (box.children.length >= 2) box.firstChild.remove();
    box.appendChild(el); setTimeout(() => el.remove(), bad ? 5000 : 2600);
  }
  async function run(fn, okMsg) {
    if (S.busy) return; S.busy = true; document.body.style.cursor = "progress";
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { console.error(e); toast(errMsg(e), true); }
    finally { S.busy = false; document.body.style.cursor = ""; }
  }
  const must = ({ data, error }) => { if (error) throw error; return data; };

  let modalOnClose = null;
  function modal(html, { wide = false, onClose = null } = {}) {
    modalOnClose = onClose;
    $("#modal-root").innerHTML = `<div class="mbg" data-act="modal-bg"><div class="modal${wide ? " wide" : ""}" role="dialog">${html}</div></div>`;
    const f = $("#modal-root [autofocus]"); if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal() { $("#modal-root").innerHTML = ""; const f = modalOnClose; modalOnClose = null; if (f) f(); }
  function ask(title, body, okLabel = "Yes", bad = false) {
    return new Promise((res) => {
      modal(`<h2>${h(title)}</h2><div class="muted">${body}</div><div class="mfoot"><button class="btn" data-act="m-no">Cancel</button><button class="btn ${bad ? "bad" : "pri"}" data-act="m-yes" autofocus>${h(okLabel)}</button></div>`, { onClose: () => res(false) });
      ACT["m-yes"] = () => { modalOnClose = null; closeModal(); res(true); };
      ACT["m-no"] = () => closeModal();
    });
  }
  function prompt(title, { label = "", value = "", type = "text", placeholder = "", okLabel = "Save", hint = "" } = {}) {
    return new Promise((res) => {
      modal(`<h2>${h(title)}</h2><label class="f">${h(label)}<input class="inp" id="pr-in" type="${type}" value="${h(value)}" placeholder="${h(placeholder)}" autofocus ${type === "number" ? 'inputmode="decimal"' : ""}></label>${hint ? `<div class="small muted" style="margin-top:6px">${hint}</div>` : ""}<div class="mfoot"><button class="btn" data-act="m-no">Cancel</button><button class="btn pri" data-act="m-yes">${h(okLabel)}</button></div>`, { onClose: () => res(null) });
      const go = () => { const v = $("#pr-in").value; modalOnClose = null; closeModal(); res(v); };
      ACT["m-yes"] = go; ACT["m-no"] = () => closeModal();
      $("#pr-in").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    });
  }

  // ───────────────────────── data ─────────────────────────
  async function loadProfile() { S.profile = must(await sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle()); }
  async function loadMaster() {
    const [st, cats, svcs] = await Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("categories").select("*").order("sort").order("name"),
      sb.from("services").select("*").order("sort").order("name"),
    ]);
    S.settings = must(st); S.cats = must(cats); S.services = must(svcs);
    if (!S.settings.payment_methods.includes(S.pay.method)) S.pay.method = S.settings.payment_methods[0] || "Cash";
  }
  async function loadShift() { S.shift = must(await sb.rpc("shift_summary")) || null; }
  const TX_SELECT = "*, cashier:profiles!transactions_cashier_id_fkey(full_name), items:transaction_items(*)";
  async function fetchTx(id) {
    const t = must(await sb.from("transactions").select(TX_SELECT).eq("id", id).single());
    t.cashier_name = t.cashier && t.cashier.full_name;
    return t;
  }

  // ───────────────────────── cart maths (mirrors create_sale) ─────────────────────────
  function totals() {
    const st = S.settings || {};
    const sub = S.cart.reduce((a, l) => a + Math.round(l.price * (Number(l.qty) || 0)), 0);
    let disc = S.disc.mode === "pct" ? Math.round(sub * Math.min(100, dec(S.disc.v)) / 100) : num(S.disc.v);
    disc = Math.max(0, Math.min(disc, sub));
    const srvPct = Number(st.service_percent) || 0, taxPct = Number(st.tax_percent) || 0;
    const srv = Math.round((sub - disc) * srvPct / 100);
    const tax = Math.round((sub - disc + srv) * taxPct / 100);
    const base = sub - disc + srv + tax;
    const feeOn = (st.card_fee_methods || []).includes(S.pay.method) && (Number(st.card_fee_percent) > 0 || Number(st.card_fee_fixed) > 0);
    const fee = feeOn ? Math.round(base * Number(st.card_fee_percent) / 100) + Number(st.card_fee_fixed || 0) : 0;
    const total = base + fee;
    const paid = S.pay.method === "Cash" ? (S.pay.paid === "" ? total : num(S.pay.paid)) : total;
    return { sub, disc, srv, srvPct, tax, taxPct, fee, total, paid, change: paid - total };
  }
  function addToCart(svc) {
    const cat = catOf(svc.category);
    const same = S.cart.find((l) => l.service_id === svc.id && !cat.is_rental);
    if (same) same.qty = (Number(same.qty) || 0) + 1;
    else S.cart.push({ key: Math.random().toString(36).slice(2), service_id: svc.id, name: svc.name, category: svc.category, unit: svc.unit, price: Number(svc.price), base: Number(svc.price), qty: 1, item_ref: "", note: "" });
    if (navigator.vibrate) navigator.vibrate(10);
  }
  function resetSale() {
    S.cart = []; S.cust = { name: "", phone: "", note: "" }; S.disc = { mode: "rp", v: "" };
    S.pay = { method: S.settings.payment_methods[0] || "Cash", paid: "" }; S.cartOpen = false;
  }

  // ───────────────────────── shell ─────────────────────────
  const NAV = () => BO
    ? [["dash", "📊", "Dashboard"], ["report", "📈", "Reports"], ["tx", "🧾", "Transactions"], ["rental", "🚲", "Rentals"], ["shifts", "⏱️", "Shifts"],
       ["services", "🏷️", "Services & prices"], ["users", "👥", "Users"], ["store", "⚙️", "Settings"]]
    : [["pos", "🧾", "Sale"], ["tx", "📋", "History"], ["rental", "🚲", "Rentals"], ["shift", "⏱️", "Shift"], ["set", "⚙️", "Settings"]];
  const VIEWS = () => BO
    ? { dash: viewDash, report: viewReport, tx: viewTx, rental: viewRental, shifts: viewShifts, services: viewServices, users: viewUsers, store: viewStore }
    : { pos: viewPOS, tx: viewTx, rental: viewRental, shift: viewShift, set: viewSettings };

  function render() {
    const app = $("#app");
    if (!S.session) { app.innerHTML = viewLogin(); return; }
    if (!S.profile || !S.profile.active) { app.innerHTML = viewPending(); return; }
    if (BO && !isAdmin()) { app.innerHTML = viewWrongApp(); return; }
    if (!S.settings) { app.innerHTML = `<div class="boot"><div class="logo-mark">PX</div><div class="muted">Loading…</div></div>`; return; }
    const nav = NAV(), body = VIEWS()[S.view] || Object.values(VIEWS())[0];
    const scroll = window.scrollY;
    app.innerHTML = `
      <header class="top">
        <div class="grow-0 top-id"><div class="brand">${h(S.settings.business_name || "PX POS")}</div>
          <div class="small muted">${BO ? "Back office" : "Cashier"} · ${h(S.profile.full_name)} · ${h(ROLE[S.profile.role] || S.profile.role)}</div></div>
        <nav class="nav">${nav.map(([k, i, l]) => `<a class="${S.view === k ? "on" : ""}" data-act="go" data-v="${k}"><span>${i}</span>${l}</a>`).join("")}</nav>
        <div class="grow"></div>
        ${BO ? `<button class="btn sm ghost hide-m" data-act="logout">Sign out</button>`
             : S.shift ? `<span class="badge hide-m">Shift open since ${fmtT(S.shift.shift.opened_at)}</span>` : `<span class="badge warn hide-m">No open shift</span>`}
      </header>
      <main class="page">${body()}</main>
      ${BO ? "" : `<nav class="bnav">${nav.map(([k, i, l]) => `<a class="${S.view === k ? "on" : ""}" data-act="go" data-v="${k}"><span class="i">${i}</span>${l}</a>`).join("")}</nav>`}`;
    if (S.view === "pos") window.scrollTo(0, scroll);
  }

  function viewLogin() {
    const reg = BO && S.authMode === "register";
    return `<div class="login"><form class="card col" data-form="${reg ? "register" : "login"}" autocomplete="on">
      <div class="row"><div class="logo-mark">PX</div><div><div class="b" style="font-size:20px">PX POS</div><div class="muted small">${BO ? "Back office" : "Cashier app"}</div></div></div>
      ${reg ? `<label class="f">Full name<input class="inp" name="full_name" required></label>` : ""}
      <label class="f">${reg ? "Email" : "Username or email"}<input class="inp" name="user" ${reg ? 'type="email"' : ""} autocomplete="${reg ? "email" : "username"}" autocapitalize="none" required></label>
      <label class="f">Password<input class="inp" name="password" type="password" autocomplete="${reg ? "new-password" : "current-password"}" required minlength="6"></label>
      <button class="btn pri lg" type="submit">${reg ? "Create account" : "Sign in"}</button>
      <div class="small muted center">${!BO ? "Your username and password are created by the owner or an admin in the back office."
        : reg ? `The first account becomes the <b>Owner</b>; later accounts wait for approval. <a href="#" data-act="auth-mode" data-m="login">Already have an account?</a>`
        : `For owners and admins. Cashiers use the PX POS Android app. <a href="#" data-act="auth-mode" data-m="register">Create an account</a>`}</div>
    </form></div>`;
  }
  function viewPending() {
    return `<div class="login"><div class="card col center">
      <div class="logo-mark" style="margin:0 auto">PX</div>
      <h3 style="margin:6px 0 0">Waiting for approval</h3>
      <div class="muted">Hi ${h(S.profile?.full_name || S.session.user.email)}, your account isn't active yet. Ask the owner or an admin to activate it in Back office → Users.</div>
      <button class="btn" data-act="recheck">Check again</button><button class="btn ghost" data-act="logout">Sign out</button>
    </div></div>`;
  }
  function viewWrongApp() {
    return `<div class="login"><div class="card col center">
      <div class="logo-mark" style="margin:0 auto">PX</div>
      <h3 style="margin:6px 0 0">Back office is for owners and admins</h3>
      <div class="muted">Hi ${h(S.profile.full_name)}, please use the <b>PX POS app on the Android device</b> to make sales.</div>
      <button class="btn ghost" data-act="logout">Sign out</button>
    </div></div>`;
  }

  // ───────────────────────── CASHIER: sale ─────────────────────────
  function viewPOS() {
    const cats = S.cats.filter((c) => c.active);
    const svcs = S.services.filter((s) => s.active && catOf(s.category).active !== false && (S.cat === "all" || s.category === S.cat));
    const qtyBy = {}; S.cart.forEach((l) => { qtyBy[l.service_id] = (qtyBy[l.service_id] || 0) + (Number(l.qty) || 0); });
    const t = totals();
    return `
      ${!S.shift ? `<div class="card row wrap" style="margin-bottom:12px;background:#fff7ea"><div class="grow">⚠️ <b>No open shift.</b> <span class="muted">Open a shift so the cash drawer can be reconciled when you close.</span></div><button class="btn sm pri" data-act="go" data-v="shift">Open shift</button></div>` : ""}
      <div class="pos">
        <section>
          <div class="cats">
            <button class="cat ${S.cat === "all" ? "on" : ""}" data-act="cat" data-c="all"><span class="ic">✨</span>All</button>
            ${cats.map((c) => `<button class="cat ${S.cat === c.code ? "on" : ""}" style="--c:${h(c.color)}" data-act="cat" data-c="${h(c.code)}"><span class="ic">${h(c.icon)}</span>${h(c.name)}</button>`).join("")}
          </div>
          <div class="svcs">
            ${svcs.map((s) => { const c = catOf(s.category); return `
              <div class="svc" style="--c:${h(c.color)}" data-act="add" data-id="${s.id}">
                ${qtyBy[s.id] ? `<span class="qty">${qtyBy[s.id].toLocaleString("en-US")}</span>` : ""}
                <span class="ic">${h(c.icon)}</span>
                <span class="nm">${h(s.name)}</span>
                ${s.description ? `<span class="small muted">${h(s.description)}</span>` : ""}
                <span class="pr">${rp(s.price)} <span class="small muted">/ ${unitL(s.unit)}</span></span>
              </div>`; }).join("") || `<div class="empty">No services yet. Add them in the back office → Services & prices.</div>`}
          </div>
        </section>
        <aside class="card cart ${S.cartOpen ? "open" : ""}" id="cart">${cartHtml(t)}</aside>
      </div>
      ${S.cart.length ? `<div class="cartbar" data-act="cart-open"><span>🛒 ${S.cart.length} item${S.cart.length > 1 ? "s" : ""}</span><span class="grow"></span><span>${rp(t.total)}</span><span>›</span></div>` : ""}`;
  }
  function cartHtml(t = totals()) {
    const methods = S.settings.payment_methods, cash = S.pay.method === "Cash";
    const quick = [...new Set([t.total, ...[50000, 100000, 200000, 500000, 1000000, 2000000].filter((v) => v > t.total).slice(0, 3)])];
    return `
      <div class="row"><h3 class="grow" style="margin:0">Cart</h3>
        ${S.cart.length ? `<button class="btn sm ghost bad" data-act="cart-clear">Clear</button>` : ""}
        <button class="btn sm ghost" data-act="cart-close" style="${S.cartOpen ? "" : "display:none"}">✕ Close</button></div>
      <div class="cart-items">
        ${S.cart.map((l) => { const c = catOf(l.category); return `
          <div class="ci">
            <div class="t"><span>${h(c.icon)}</span><div class="grow"><div class="b">${h(l.name)}</div>
              <div class="small muted"><a href="#" data-act="price" data-k="${l.key}" style="color:inherit">${rp(l.price)}</a> / ${unitL(l.unit)}${l.price !== l.base ? ` <span class="badge warn">price changed</span>` : ""}</div></div>
              <div class="b">${rp(Math.round(l.price * (Number(l.qty) || 0)))}</div></div>
            <div class="ctrl">
              <button class="step" data-act="qty" data-k="${l.key}" data-d="-1">−</button>
              <input class="inp q" style="width:64px;min-height:36px;padding:4px;text-align:center" inputmode="decimal" value="${h(l.qty)}" data-bind="qty" data-k="${l.key}">
              <button class="step" data-act="qty" data-k="${l.key}" data-d="1">+</button>
              <span class="small muted">${unitL(l.unit, l.qty)}</span>
              <span class="grow"></span>
              ${c.is_rental ? `<button class="btn sm" data-act="dup" data-k="${l.key}">+ unit</button>` : ""}
              <button class="btn sm ghost bad" data-act="del" data-k="${l.key}" title="Remove">🗑</button>
            </div>
            <input class="inp" style="margin-top:8px;min-height:38px" placeholder="${h(REF_HINT[l.category] || "Reference")}" value="${h(l.item_ref)}" data-bind="ref" data-k="${l.key}">
          </div>`; }).join("") || `<div class="empty">Tap a service to add it.</div>`}
      </div>
      ${S.cart.length ? `
      <div class="col" style="gap:8px">
        <div class="grid2" style="gap:8px">
          <input class="inp" placeholder="Guest name" value="${h(S.cust.name)}" data-bind="cust" data-f="name">
          <input class="inp" placeholder="Phone / WhatsApp" inputmode="tel" value="${h(S.cust.phone)}" data-bind="cust" data-f="phone">
        </div>
        <input class="inp" placeholder="Room / hotel / note" value="${h(S.cust.note)}" data-bind="cust" data-f="note">
        <div class="row" style="gap:6px">
          <input class="inp grow" placeholder="Discount" inputmode="decimal" value="${h(S.disc.v)}" data-bind="disc">
          <button class="chip ${S.disc.mode === "rp" ? "on" : ""}" data-act="disc-mode" data-m="rp">Rp</button>
          <button class="chip ${S.disc.mode === "pct" ? "on" : ""}" data-act="disc-mode" data-m="pct">%</button>
        </div>
      </div>
      <div class="totals" id="totals">${totalsHtml(t)}</div>
      <div class="chips" style="margin-top:10px">${methods.map((m) => `<button class="chip ${S.pay.method === m ? "on" : ""}" data-act="method" data-m="${h(m)}">${h(m)}</button>`).join("")}</div>
      ${cash ? `
        <label class="f" style="margin-top:10px">Cash received<input class="inp" inputmode="numeric" placeholder="${h(P.num(t.total))}" value="${h(S.pay.paid)}" data-bind="paid"></label>
        <div class="chips" style="margin-top:8px">${quick.map((v) => `<button class="chip" data-act="paid" data-v="${v}">${v === t.total ? "Exact" : (v / 1000).toLocaleString("en-US") + "k"}</button>`).join("")}</div>` : ""}
      <button class="btn pri lg" style="width:100%;margin-top:12px" data-act="checkout" id="btn-pay" ${t.change < 0 ? "disabled" : ""}>Charge ${rp(t.total)}</button>` : ""}`;
  }
  function totalsHtml(t) {
    const st = S.settings;
    return `<div class="row"><span class="grow muted">Subtotal</span><span>${rp(t.sub)}</span></div>
      ${t.disc ? `<div class="row"><span class="grow muted">Discount</span><span>− ${rp(t.disc)}</span></div>` : ""}
      ${t.srvPct ? `<div class="row"><span class="grow muted">${h(st.service_label || "Service")} ${t.srvPct}%</span><span>${rp(t.srv)}</span></div>` : ""}
      ${t.taxPct ? `<div class="row"><span class="grow muted">${h(st.tax_label || "Tax")} ${t.taxPct}%</span><span>${rp(t.tax)}</span></div>` : ""}
      ${t.fee ? `<div class="row"><span class="grow muted">${h(st.card_fee_label || "Card fee")}${Number(st.card_fee_percent) ? " " + Number(st.card_fee_percent) + "%" : ""}</span><span>${rp(t.fee)}</span></div>` : ""}
      <div class="row"><span class="grow b">Total</span><span class="grand">${rp(t.total)}</span></div>
      ${S.pay.method === "Cash" && S.pay.paid !== "" ? `<div class="row"><span class="grow muted">Change</span><span class="b" style="color:${t.change < 0 ? "var(--bad)" : "var(--ok)"}">${t.change < 0 ? "Short by " + rp(-t.change) : rp(t.change)}</span></div>` : ""}`;
  }
  function refreshTotals() {
    const t = totals();
    const el = $("#totals"); if (el) el.innerHTML = totalsHtml(t);
    const b = $("#btn-pay"); if (b) { b.textContent = "Charge " + rp(t.total); b.disabled = t.change < 0; }
    const bar = $(".cartbar span:nth-child(3)"); if (bar) bar.textContent = rp(t.total);
  }
  async function checkout() {
    const t = totals();
    if (!S.cart.length) return;
    if (S.cart.some((l) => !(Number(l.qty) > 0))) return toast("Quantities must be more than 0", true);
    if (t.change < 0) return toast("Cash received is less than the total", true);
    const payload = {
      customer_name: S.cust.name.trim(), customer_phone: S.cust.phone.trim(), customer_note: S.cust.note.trim(),
      discount: t.disc, payment_method: S.pay.method, amount_paid: t.paid,
      items: S.cart.map((l) => Object.assign({ service_id: l.service_id, qty: Number(l.qty), item_ref: l.item_ref.trim(), note: l.note }, l.price !== l.base ? { price: l.price } : {})),
    };
    const res = await run(async () => must(await sb.rpc("create_sale", { p: payload })));
    if (!res) return;
    resetSale();
    loadShift().then(() => { if (S.view === "pos") render(); }).catch(() => {});
    render();
    const tx = await run(() => fetchTx(res.id));
    if (!tx) return;
    showReceipt(tx, { fresh: true });
    if (P.getCfg().autoPrint) printTx(tx);
  }

  // ───────────────────────── receipts ─────────────────────────
  function showReceipt(tx, { fresh = false } = {}) {
    const lines = P.buildReceipt(tx, tx.items, S.settings);
    const canVoid = BO && isAdmin() && tx.status === "paid";
    modal(`
      ${fresh ? `<div class="center" style="margin-bottom:10px"><div style="font-size:40px">✅</div><div class="b" style="font-size:18px">Payment complete</div>
        ${Number(tx.change_amount) ? `<div class="muted">Change</div><div class="b" style="font-size:28px;color:var(--pri)">${rp(tx.change_amount)}</div>` : ""}</div>` :
        `<h2>${h(tx.receipt_no)} ${tx.status === "void" ? `<span class="badge bad">VOID</span>` : ""}</h2>`}
      ${tx.status === "void" ? `<div class="small" style="color:var(--bad);margin-bottom:8px">Voided${tx.voided_at ? " " + fmtDT(tx.voided_at) : ""}: ${h(tx.void_reason || "")}</div>` : ""}
      ${P.toHtml(lines)}
      <div class="mfoot">
        ${canVoid ? `<button class="btn bad" data-act="void" data-id="${tx.id}">Void sale</button>` : ""}
        <span class="grow"></span>
        ${BO ? "" : `<button class="btn" data-act="wa" data-id="${tx.id}">WhatsApp</button>`}
        <button class="btn" data-act="print" data-id="${tx.id}">🖨 Print</button>
        <button class="btn pri" data-act="m-close">${fresh ? "New sale" : "Close"}</button>
      </div>`);
    S.lastTx = tx;
  }
  async function printTx(tx, copyLabel) {
    const lines = P.buildReceipt(tx, tx.items, S.settings, { copyLabel });
    await run(async () => { const m = await P.print(lines, BO ? { method: "system" } : undefined); if (m !== "system" && m !== "rawbt") toast("Receipt printed"); });
  }
  function waTx(tx) {
    const text = "```\n" + P.toText(P.buildReceipt(tx, tx.items, S.settings, { width: 32, logo: false }), 32) + "\n```";
    let phone = String(tx.customer_phone || "").replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "62" + phone.slice(1);
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    if (P.isNative()) window.location.href = url; else window.open(url, "_blank");
  }

  // ───────────────────────── transactions (both) ─────────────────────────
  async function loadTx() {
    const rows = must(await sb.from("transactions").select(TX_SELECT)
      .gte("created_at", dayStartISO(S.tx.from)).lt("created_at", dayEndISO(S.tx.to)).order("created_at", { ascending: false }).limit(1000));
    S.tx.rows = rows.map((t) => Object.assign(t, { cashier_name: t.cashier && t.cashier.full_name }));
  }
  function viewTx() {
    if (S.tx.rows === null) { loadTx().then(render).catch((e) => toast(errMsg(e), true)); return `<div class="empty">Loading transactions…</div>`; }
    const q = S.tx.q.trim().toLowerCase();
    const rows = S.tx.rows.filter((t) => !q || [t.receipt_no, t.customer_name, t.customer_phone, t.customer_note, t.cashier_name, ...t.items.map((i) => i.name + " " + i.item_ref)].join(" ").toLowerCase().includes(q));
    const paid = rows.filter((t) => t.status === "paid");
    return `
      <div class="card" style="margin-bottom:12px"><div class="row wrap">
        ${BO ? `<label class="f">From<input class="inp" type="date" value="${S.tx.from}" data-bind="tx-from"></label>
        <label class="f">To<input class="inp" type="date" value="${S.tx.to}" data-bind="tx-to"></label>` : ""}
        <label class="f grow" style="min-width:180px">Search<input class="inp" placeholder="Receipt no., guest, bike no.…" value="${h(S.tx.q)}" data-bind="tx-q"></label>
        <button class="btn" data-act="tx-reload" style="align-self:flex-end">↻</button>
      </div>
      <div class="row small muted" style="margin-top:10px"><span>${paid.length} sale${paid.length === 1 ? "" : "s"}${BO ? "" : " · today & yesterday"}</span><span class="grow"></span><span class="b" style="color:var(--ink)">${rp(paid.reduce((a, t) => a + Number(t.total), 0))}</span></div></div>
      <div class="card list">
        ${rows.map((t) => `<div class="li" data-act="tx-open" data-id="${t.id}" style="cursor:pointer">
          <div style="font-size:22px">${h(catOf(t.items[0]?.category).icon)}</div>
          <div class="grow"><div class="b">${h(t.receipt_no)} ${t.status === "void" ? `<span class="badge bad">VOID</span>` : ""}</div>
            <div class="small muted">${fmtDT(t.created_at)} · ${h(t.customer_name || "Guest")} · ${h(t.items.map((i) => i.name).join(", "))}${BO ? ` · ${h(t.cashier_name || "")}` : ""}</div></div>
          <div class="right"><div class="b" style="${t.status === "void" ? "text-decoration:line-through;color:var(--muted)" : ""}">${rp(t.total)}</div><div class="small muted">${h(t.payment_method)}</div></div>
        </div>`).join("") || `<div class="empty">No transactions.</div>`}
      </div>`;
  }

  // ───────────────────────── rentals (both) ─────────────────────────
  async function loadRentals() {
    S.rentals = must(await sb.from("transaction_items").select("*, tx:transactions(receipt_no, customer_name, customer_phone, customer_note, status)")
      .eq("rental_status", "out").order("due_at", { ascending: true }));
  }
  function viewRental() {
    if (S.rentals === null) { loadRentals().then(render).catch((e) => toast(errMsg(e), true)); return `<div class="empty">Loading rentals…</div>`; }
    const now = Date.now();
    const rows = S.rentals.filter((r) => r.tx && r.tx.status === "paid");
    const late = rows.filter((r) => r.due_at && new Date(r.due_at).getTime() < now);
    return `
      <div class="kpis" style="margin-bottom:12px">
        <div class="kpi"><div class="muted small">Out now</div><div class="v">${rows.length}</div></div>
        <div class="kpi"><div class="muted small">Overdue</div><div class="v" style="color:${late.length ? "var(--bad)" : "inherit"}">${late.length}</div></div>
        ${S.cats.filter((c) => c.is_rental).map((c) => `<div class="kpi"><div class="muted small">${h(c.icon)} ${h(c.name)}</div><div class="v">${rows.filter((r) => r.category === c.code).length}</div></div>`).join("")}
      </div>
      <div class="card list">
        <div class="row" style="margin-bottom:4px"><h3 class="grow" style="margin:0">Units out</h3><button class="btn sm" data-act="rental-reload">↻</button></div>
        ${rows.map((r) => { const over = r.due_at && new Date(r.due_at).getTime() < now; return `<div class="li">
          <div style="font-size:24px">${h(catOf(r.category).icon)}</div>
          <div class="grow"><div class="b">${h(r.name)} ${r.item_ref ? `· <span style="color:var(--pri)">${h(r.item_ref)}</span>` : ""}</div>
            <div class="small muted">${h(r.tx.customer_name || "Guest")}${r.tx.customer_note ? " · " + h(r.tx.customer_note) : ""} · ${h(r.tx.receipt_no)}</div>
            <div class="small">Out ${fmtDT(r.start_at)} → due <b>${r.due_at ? fmtDT(r.due_at) : "-"}</b> ${over ? `<span class="badge bad">Overdue</span>` : ""}</div></div>
          <button class="btn pri sm" data-act="return" data-id="${r.id}">✓ Returned</button>
        </div>`; }).join("") || `<div class="empty">Everything is back 👍</div>`}
      </div>`;
  }

  // ───────────────────────── CASHIER: shift ─────────────────────────
  async function loadShifts() {
    let q = sb.from("shifts").select("*, cashier:profiles(full_name)").order("opened_at", { ascending: false }).limit(BO ? 100 : 15);
    if (!BO) q = q.eq("cashier_id", S.profile.id);
    S.shifts = must(await q);
  }
  function shiftTable() {
    if (!S.shifts) { loadShifts().then(render).catch(() => {}); return `<div class="muted">Loading…</div>`; }
    return `<table class="t"><thead><tr>${BO ? "<th>Cashier</th>" : ""}<th>Opened</th><th>Closed</th><th class="n">Expected cash</th><th class="n">Counted</th><th class="n">Difference</th></tr></thead><tbody>
      ${S.shifts.map((x) => { const d = x.closed_at ? Number(x.closing_cash) - Number(x.expected_cash) : null; return `<tr>
        ${BO ? `<td>${h(x.cashier?.full_name || "")}</td>` : ""}<td>${fmtDT(x.opened_at)}</td><td>${x.closed_at ? fmtDT(x.closed_at) : `<span class="badge">open</span>`}</td>
        <td class="n">${x.closed_at ? rp(x.expected_cash) : "-"}</td><td class="n">${x.closed_at ? rp(x.closing_cash) : "-"}</td>
        <td class="n" style="color:${d < 0 ? "var(--bad)" : d > 0 ? "var(--warn)" : "inherit"}">${d === null ? "-" : (d > 0 ? "+" : "") + rp(d)}</td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">No shifts yet.</td></tr>`}</tbody></table>`;
  }
  function viewShift() {
    const s = S.shift;
    const body = !s ? `
      <div class="card col" style="max-width:460px">
        <h3>Open shift</h3>
        <label class="f">Opening cash in drawer<input class="inp" id="open-cash" inputmode="numeric" placeholder="0"></label>
        <button class="btn pri lg" data-act="shift-open">Open shift</button>
      </div>` : `
      <div class="grid2">
        <div class="card col">
          <h3>Current shift</h3>
          <div class="row"><span class="grow muted">Opened</span><b>${fmtDT(s.shift.opened_at)}</b></div>
          <div class="row"><span class="grow muted">Opening cash</span><b>${rp(s.shift.opening_cash)}</b></div>
          <div class="row"><span class="grow muted">Sales</span><b>${s.count}${s.void_count ? ` <span class="badge bad">${s.void_count} void</span>` : ""}</b></div>
          ${Object.entries(s.by_method || {}).map(([m, v]) => `<div class="row"><span class="grow muted">${h(m)}</span><b>${rp(v)}</b></div>`).join("")}
          <div class="row"><span class="grow b">Total sales</span><b style="font-size:20px;color:var(--pri)">${rp(s.total)}</b></div>
          <div class="row"><span class="grow muted">Cash expected in drawer</span><b>${rp(Number(s.shift.opening_cash) + Number(s.cash_sales))}</b></div>
        </div>
        <div class="card col">
          <h3>Close shift</h3>
          <label class="f">Cash counted<input class="inp" id="close-cash" inputmode="numeric" placeholder="0"></label>
          <label class="f">Note<input class="inp" id="close-note" placeholder="optional"></label>
          <button class="btn pri lg" data-act="shift-close">Close shift & print summary</button>
        </div>
      </div>`;
    return body + `<div class="card" style="margin-top:14px"><h3>My recent shifts</h3>${shiftTable()}</div>`;
  }
  function shiftLines(sum) {
    const w = P.getCfg().width, st = S.settings, s = sum.shift;
    const lr = (l, r) => { l = String(l); r = String(r); return l + " ".repeat(Math.max(1, w - l.length - r.length)) + r; };
    const n = P.num;
    const L = [{ t: st.business_name, align: "center", bold: true, big: true }, { t: "SHIFT SUMMARY", align: "center", bold: true }, { t: "=".repeat(w) },
      { t: lr("Cashier", S.profile.full_name) }, { t: lr("Opened", fmtDT(s.opened_at)) }, { t: lr("Closed", s.closed_at ? fmtDT(s.closed_at) : "-") }, { t: "-".repeat(w) },
      { t: lr("Sales", sum.count) }, { t: lr("Voided", sum.void_count) },
      ...Object.entries(sum.by_method || {}).map(([m, v]) => ({ t: lr(m, n(v)) })),
      { t: lr("TOTAL", n(sum.total)), bold: true }, { t: "-".repeat(w) },
      { t: lr("Opening cash", n(s.opening_cash)) }, { t: lr("Expected cash", n(s.expected_cash ?? Number(s.opening_cash) + Number(sum.cash_sales))) },
      { t: lr("Counted cash", n(s.closing_cash)) }, { t: lr("Difference", n(Number(s.closing_cash) - Number(s.expected_cash))), bold: true },
      ...(s.note ? [{ t: "Note: " + s.note }] : []), { t: "" }];
    return L.map((l) => Object.assign({ align: "left", bold: false, big: false }, l, { t: String(l.t ?? "").normalize("NFD").replace(/[^\x20-\x7E]/g, "") }));
  }

  // ───────────────────────── CASHIER: settings ─────────────────────────
  function viewSettings() {
    const c = P.getCfg();
    const opts = [["auto", "Automatic"], ...(P.hasNative() ? [["native", "Bluetooth (paired printer)"]] : []), ...(P.hasWebBt() && !P.isNative() ? [["webbt", "Bluetooth BLE (browser)"]] : []),
      ...(P.isAndroid ? [["rawbt", "RawBT app"]] : []), ["system", "System print dialog / PDF"]];
    return `<div class="grid2">
      <div class="card col">
        <h3>🖨 Receipt printer (this device)</h3>
        <label class="f">Print with<select class="inp" data-bind="pr" data-f="method">${opts.map(([k, l]) => `<option value="${k}" ${c.method === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        ${P.hasNative() ? `<div class="row"><div class="grow"><div class="small muted">Selected printer</div><div class="b">${h(c.name || "None yet")}</div><div class="small muted">${h(c.address)}</div></div><button class="btn" data-act="pr-pick">Choose printer</button></div>
          <div class="small muted">Pair the printer first in Android Bluetooth settings (PIN is usually 0000 or 1234).</div>` : ""}
        ${!P.isNative() && P.hasWebBt() ? `<div class="row"><div class="grow"><div class="small muted">BLE printer</div><div class="b">${h(c.name || "Not connected")}</div></div><button class="btn" data-act="pr-ble">Connect</button></div>` : ""}
        <div class="grid2" style="gap:10px">
          <label class="f">Paper width<select class="inp" data-bind="pr" data-f="width"><option value="32" ${c.width == 32 ? "selected" : ""}>58 mm (32 columns)</option><option value="48" ${c.width == 48 ? "selected" : ""}>80 mm (48 columns)</option></select></label>
          <label class="f">Copies<select class="inp" data-bind="pr" data-f="copies">${[1, 2, 3].map((n) => `<option ${c.copies == n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        </div>
        <label class="row"><input type="checkbox" data-bind="pr" data-f="logo" ${c.logo ? "checked" : ""}> Print the logo${S.settings.logo_data ? "" : ` <span class="small muted">(no logo uploaded in the back office yet)</span>`}</label>
        <label class="row"><input type="checkbox" data-bind="pr" data-f="autoPrint" ${c.autoPrint ? "checked" : ""}> Print automatically after payment</label>
        <label class="row"><input type="checkbox" data-bind="pr" data-f="cut" ${c.cut ? "checked" : ""}> Cut paper (printers with a cutter)</label>
        <button class="btn pri" data-act="pr-test">Test print</button>
      </div>
      <div class="card col">
        <h3>👤 Account</h3>
        <div><div class="b">${h(S.profile.full_name)}</div><div class="small muted">${h(S.profile.username || S.session.user.email)} · ${h(ROLE[S.profile.role])}</div></div>
        <button class="btn" data-act="my-pw">Change password</button>
        <button class="btn bad" data-act="logout">Sign out</button>
        <div class="small muted">PX POS cashier v${h(C.version)}${P.isNative() ? " · Android" : " · Web"}</div>
      </div>
    </div>`;
  }

  // ───────────────────────── BACK OFFICE ─────────────────────────
  function bars(rows, labelFn, valFn, colorFn) {
    const max = Math.max(1, ...rows.map(valFn));
    return rows.map((r) => `<div style="margin:8px 0"><div class="row small"><span class="grow">${labelFn(r)}</span><b>${rp(valFn(r))}</b></div>
      <div class="bar" style="--c:${colorFn ? colorFn(r) : "var(--pri)"}"><i style="width:${(valFn(r) / max * 100).toFixed(1)}%"></i></div></div>`).join("") || `<div class="muted small">No data yet.</div>`;
  }
  function viewDash() {
    if (!S.dash) {
      Promise.all([
        sb.rpc("sales_report", { p_from: today(), p_to: today() }),
        sb.rpc("sales_report", { p_from: monthStart(), p_to: today() }),
        sb.rpc("sales_report", { p_from: addDays(today(), -13), p_to: today() }),
        sb.from("transaction_items").select("id, due_at, tx:transactions(status)").eq("rental_status", "out"),
      ]).then(([a, b, c, r]) => { S.dash = { today: must(a), month: must(b), d14: must(c), out: must(r).filter((x) => x.tx?.status === "paid") }; render(); }).catch((e) => toast(errMsg(e), true));
      return `<div class="empty">Loading dashboard…</div>`;
    }
    const { today: td, month: mo, d14, out } = S.dash;
    const days = []; for (let i = 13; i >= 0; i--) { const d = addDays(today(), -i); const f = d14.by_day.find((x) => x.day === d); days.push({ day: d, total: f ? Number(f.total) : 0 }); }
    const max = Math.max(1, ...days.map((d) => d.total));
    const late = out.filter((r) => r.due_at && new Date(r.due_at) < new Date()).length;
    return `
      <div class="kpis">
        <div class="kpi"><div class="muted small">Sales today</div><div class="v">${rp(td.total)}</div><div class="small muted">${td.count} sale${td.count === 1 ? "" : "s"}</div></div>
        <div class="kpi"><div class="muted small">This month</div><div class="v">${rp(mo.total)}</div><div class="small muted">${mo.count} sales</div></div>
        <div class="kpi"><div class="muted small">Average sale (month)</div><div class="v">${rp(mo.count ? mo.total / mo.count : 0)}</div></div>
        <div class="kpi"><div class="muted small">Bikes out now</div><div class="v">${out.length}</div><div class="small" style="color:${late ? "var(--bad)" : "var(--muted)"}">${late} overdue</div></div>
      </div>
      <div class="card" style="margin-top:14px"><div class="row"><h3 class="grow">Last 14 days</h3><button class="btn sm" data-act="dash-reload">↻</button></div>
        <div style="display:flex;align-items:flex-end;gap:6px;height:170px;padding-top:10px">
          ${days.map((d) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end" title="${fmtD(d.day)}: ${rp(d.total)}">
            <div style="width:100%;max-width:38px;background:var(--pri);opacity:${d.day === today() ? 1 : .55};border-radius:6px 6px 2px 2px;height:${Math.max(2, d.total / max * 130)}px"></div>
            <div class="small muted" style="font-size:10px">${new Date(d.day + "T00:00:00").getDate()}</div></div>`).join("")}
        </div></div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>By category — this month</h3>${bars(mo.by_category, (r) => `${h(catOf(r.category).icon)} ${h(catOf(r.category).name)} <span class="muted">(${Number(r.qty).toLocaleString("en-US")})</span>`, (r) => Number(r.total), (r) => catOf(r.category).color)}</div>
        <div class="card"><h3>Today by payment method</h3>${bars(td.by_method, (r) => `${h(r.method)} <span class="muted">(${r.count})</span>`, (r) => Number(r.total))}</div>
      </div>`;
  }

  let repLoading = false;
  async function loadReport() {
    if (repLoading) return; repLoading = true;
    try { S.rep.data = must(await sb.rpc("sales_report", { p_from: S.rep.from, p_to: S.rep.to })); render(); }
    catch (e) { toast(errMsg(e), true); } finally { repLoading = false; }
  }
  function viewReport() {
    const R = S.rep.data;
    const lastMonthStart = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return isoOf(d); })();
    const presets = [["Today", today(), today()], ["Yesterday", addDays(today(), -1), addDays(today(), -1)], ["Last 7 days", addDays(today(), -6), today()],
      ["This month", monthStart(), today()], ["Last month", lastMonthStart, addDays(monthStart(), -1)]];
    if (!R) loadReport();
    const st = S.settings;
    return `
      <div class="card" style="margin-bottom:14px">
        <div class="chips" style="margin-bottom:10px">${presets.map(([l, a, b]) => `<button class="chip ${S.rep.from === a && S.rep.to === b ? "on" : ""}" data-act="rep-preset" data-a="${a}" data-b="${b}">${l}</button>`).join("")}</div>
        <div class="row wrap">
          <label class="f">From<input class="inp" type="date" value="${S.rep.from}" data-bind="rep-from"></label>
          <label class="f">To<input class="inp" type="date" value="${S.rep.to}" data-bind="rep-to"></label>
          <span class="grow"></span>
          <button class="btn" data-act="rep-print" style="align-self:flex-end">🖨 Print</button>
          <button class="btn pri" data-act="rep-csv" style="align-self:flex-end">⬇ Export CSV</button>
        </div>
      </div>
      ${!R ? `<div class="empty">Loading report…</div>` : `
      <div class="kpis">
        <div class="kpi"><div class="muted small">Net sales</div><div class="v">${rp(R.total)}</div></div>
        <div class="kpi"><div class="muted small">Sales</div><div class="v">${R.count}</div><div class="small muted">${R.void_count} voided</div></div>
        <div class="kpi"><div class="muted small">Gross</div><div class="v">${rp(R.gross)}</div><div class="small muted">Discounts ${rp(R.discount)}</div></div>
        <div class="kpi"><div class="muted small">${h(st.service_label)} / ${h(st.tax_label)}</div><div class="v">${rp(Number(R.service) + Number(R.tax))}</div><div class="small muted">${rp(R.service)} + ${rp(R.tax)}</div></div>
        <div class="kpi"><div class="muted small">${h(st.card_fee_label || "Card fee")}</div><div class="v">${rp(R.card_fee || 0)}</div><div class="small muted">included in net sales</div></div>
      </div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>By category</h3>${bars(R.by_category, (r) => `${h(catOf(r.category).icon)} ${h(catOf(r.category).name)}`, (r) => Number(r.total), (r) => catOf(r.category).color)}</div>
        <div class="card"><h3>By payment method</h3>${bars(R.by_method, (r) => `${h(r.method)} <span class="muted">(${r.count})</span>`, (r) => Number(r.total))}</div>
      </div>
      <div class="card" style="margin-top:14px"><h3>By service</h3><table class="t"><thead><tr><th>Service</th><th class="n">Qty</th><th class="n">Sales</th></tr></thead><tbody>
        ${R.by_service.map((r) => `<tr><td>${h(catOf(r.category).icon)} ${h(r.name)}</td><td class="n">${Number(r.qty).toLocaleString("en-US")}</td><td class="n">${rp(r.total)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No data</td></tr>`}</tbody></table></div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>By cashier</h3><table class="t"><tbody>${R.by_cashier.map((r) => `<tr><td>${h(r.cashier)}</td><td class="n">${r.count} sales</td><td class="n">${rp(r.total)}</td></tr>`).join("") || `<tr><td class="muted">-</td></tr>`}</tbody></table></div>
        <div class="card"><h3>By day</h3><table class="t"><tbody>${R.by_day.map((r) => `<tr><td>${fmtD(r.day)}</td><td class="n">${r.count} sales</td><td class="n">${rp(r.total)}</td></tr>`).join("") || `<tr><td class="muted">-</td></tr>`}</tbody></table></div>
      </div>`}`;
  }
  async function exportCsv() {
    const rows = await run(async () => must(await sb.from("transactions").select(TX_SELECT)
      .gte("created_at", dayStartISO(S.rep.from)).lt("created_at", dayEndISO(S.rep.to)).order("created_at").limit(10000)));
    if (!rows) return;
    const q = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Receipt", "Date", "Time", "Status", "Cashier", "Guest", "Phone", "Note", "Category", "Service", "Ref", "Qty", "Unit", "Price", "Amount", "Receipt subtotal", "Receipt discount", "Receipt service", "Receipt tax", "Receipt card fee", "Receipt total", "Payment method"];
    const out = [head.join(",")];
    for (const t of rows) for (const [i, it] of t.items.entries()) {
      out.push([t.receipt_no, isoOf(new Date(t.created_at)), fmtT(t.created_at), t.status, t.cashier?.full_name, t.customer_name, t.customer_phone, t.customer_note,
        catOf(it.category).name, it.name, it.item_ref, it.qty, unitL(it.unit, it.qty), it.price, it.line_total,
        i === 0 ? t.subtotal : "", i === 0 ? t.discount : "", i === 0 ? t.service_charge : "", i === 0 ? t.tax : "", i === 0 ? t.card_fee : "", i === 0 ? t.total : "", t.payment_method].map(q).join(","));
    }
    const blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `PX-POS_${S.rep.from}_${S.rep.to}.csv`; document.body.appendChild(a); a.click(); a.remove();
    toast("CSV downloaded");
  }
  function reportLines() {
    const R = S.rep.data, w = 32, n = P.num;
    const lr = (l, r) => { r = String(r); l = String(l).slice(0, w - r.length - 1); return l + " ".repeat(Math.max(1, w - l.length - r.length)) + r; };
    const L = [[S.settings.business_name, "center", true, true], ["SALES REPORT", "center", true], [`${S.rep.from} to ${S.rep.to}`, "center"], ["=".repeat(w)],
      [lr("Sales", R.count)], [lr("Voided", R.void_count)], [lr("Gross", n(R.gross))], [lr("Discounts", n(R.discount))],
      ...(Number(R.service) ? [[lr(S.settings.service_label, n(R.service))]] : []), ...(Number(R.tax) ? [[lr(S.settings.tax_label, n(R.tax))]] : []), ...(Number(R.card_fee) ? [[lr(S.settings.card_fee_label || "Card fee", n(R.card_fee))]] : []),
      [lr("NET SALES", n(R.total)), "left", true], ["-".repeat(w)], ["By service:", "left", true],
      ...R.by_service.map((r) => [lr(`${r.name} x${Number(r.qty).toLocaleString("en-US")}`, n(r.total))]), ["-".repeat(w)], ["By payment method:", "left", true],
      ...R.by_method.map((r) => [lr(r.method, n(r.total))]), ["-".repeat(w)], [`Printed ${fmtDT(new Date())}`, "center"], [""]];
    return L.map(([t, align = "left", bold = false, big = false]) => ({ t: String(t ?? "").normalize("NFD").replace(/[^\x20-\x7E]/g, ""), align, bold, big }));
  }

  function viewShifts() { return `<div class="card"><div class="row"><h3 class="grow">Shifts</h3><button class="btn sm" data-act="shifts-reload">↻</button></div>${shiftTable()}</div>`; }

  function viewServices() {
    return `
      <div class="row wrap" style="margin-bottom:12px"><span class="grow muted small">Click a service to change its name or price. Changes reach the cashier app immediately.</span>
        <button class="btn" data-act="cat-edit" data-c="">+ Category</button><button class="btn pri" data-act="svc-edit" data-id="">+ Service</button></div>
      ${S.cats.map((c) => `<div class="card" style="margin-bottom:12px;${c.active ? "" : "opacity:.6"}">
        <div class="row"><span style="font-size:24px">${h(c.icon)}</span><h3 class="grow" style="margin:0">${h(c.name)} ${c.is_rental ? `<span class="badge">rental</span>` : ""} ${c.active ? "" : `<span class="badge gray">hidden</span>`}</h3>
          <button class="btn sm" data-act="cat-edit" data-c="${h(c.code)}">Edit</button></div>
        <div class="list">${S.services.filter((s) => s.category === c.code).map((s) => `<div class="li" data-act="svc-edit" data-id="${s.id}" style="cursor:pointer">
          <div class="grow"><div class="b">${h(s.name)} ${s.active ? "" : `<span class="badge gray">hidden</span>`}</div><div class="small muted">${h(s.description || "")}${s.duration_hours ? ` · ${Number(s.duration_hours)} h` : ""}</div></div>
          <div class="b">${rp(s.price)} <span class="small muted">/ ${unitL(s.unit)}</span></div></div>`).join("") || `<div class="muted small" style="padding:8px 0">No services yet.</div>`}</div>
      </div>`).join("")}`;
  }
  function svcForm(id) {
    const s = S.services.find((x) => x.id === id) || { category: S.cats[0]?.code, name: "", price: 0, unit: "session", description: "", duration_hours: null, active: true, sort: 0 };
    modal(`<h2>${id ? "Edit service" : "New service"}</h2><form class="col" data-form="svc" data-id="${id || ""}">
      <label class="f">Category<select class="inp" name="category">${S.cats.map((c) => `<option value="${h(c.code)}" ${c.code === s.category ? "selected" : ""}>${h(c.icon)} ${h(c.name)}</option>`).join("")}</select></label>
      <label class="f">Service name<input class="inp" name="name" value="${h(s.name)}" required autofocus></label>
      <div class="grid2" style="gap:10px">
        <label class="f">Price (Rp)<input class="inp" name="price" inputmode="numeric" value="${Number(s.price)}" required></label>
        <label class="f">Unit<select class="inp" name="unit">${Object.keys(P.UNIT).map((k) => `<option value="${k}" ${k === s.unit ? "selected" : ""}>per ${k}</option>`).join("")}</select></label>
      </div>
      <div class="grid2" style="gap:10px">
        <label class="f">Fixed duration (hours, optional)<input class="inp" name="duration_hours" inputmode="decimal" value="${s.duration_hours ?? ""}"></label>
        <label class="f">Sort order<input class="inp" name="sort" inputmode="numeric" value="${s.sort}"></label>
      </div>
      <label class="f">Description<input class="inp" name="description" value="${h(s.description)}"></label>
      <label class="row"><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Active (shown in the cashier app)</label>
      <div class="mfoot">${id ? `<button type="button" class="btn bad" data-act="svc-del" data-id="${id}">Delete</button><span class="grow"></span>` : ""}
        <button type="button" class="btn" data-act="m-close">Cancel</button><button class="btn pri" type="submit">Save</button></div></form>`);
  }
  function catForm(code) {
    const c = S.cats.find((x) => x.code === code) || { code: "", name: "", icon: "🛎️", color: "#0f766e", is_rental: false, sort: S.cats.length + 1, active: true };
    modal(`<h2>${code ? "Edit category" : "New category"}</h2><form class="col" data-form="cat" data-c="${h(code || "")}">
      <div class="grid2" style="gap:10px">
        <label class="f">Name<input class="inp" name="name" value="${h(c.name)}" required autofocus></label>
        <label class="f">Code (lowercase)<input class="inp" name="code" value="${h(c.code)}" ${code ? "readonly" : ""} pattern="[a-z0-9_]{2,30}" required></label>
      </div>
      <div class="grid3">
        <label class="f">Icon (emoji)<input class="inp" name="icon" value="${h(c.icon)}"></label>
        <label class="f">Colour<input class="inp" type="color" name="color" value="${h(c.color)}" style="padding:4px"></label>
        <label class="f">Sort order<input class="inp" name="sort" inputmode="numeric" value="${c.sort}"></label>
      </div>
      <label class="row"><input type="checkbox" name="is_rental" ${c.is_rental ? "checked" : ""}> Rental (units go out and must come back — listed under Rentals)</label>
      <label class="row"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Active</label>
      <div class="mfoot"><button type="button" class="btn" data-act="m-close">Cancel</button><button class="btn pri" type="submit">Save</button></div></form>`);
  }

  function viewUsers() {
    if (!S.users) { sb.from("profiles").select("*").order("created_at").then((r) => { S.users = must(r); render(); }).catch((e) => toast(errMsg(e), true)); return `<div class="empty">Loading users…</div>`; }
    return `<div class="row" style="margin-bottom:12px"><span class="grow muted small">Cashiers sign in to the Android app with the <b>username</b> and password you create here. Only owners and admins can open the back office.</span><button class="btn pri" data-act="user-new">+ User</button></div>
      <div class="card list">${S.users.map((u) => `<div class="li">
        <div class="logo-mark" style="width:38px;height:38px;font-size:14px;border-radius:12px;${u.active ? "" : "filter:grayscale(1);opacity:.6"}">${h((u.full_name || "?").slice(0, 2).toUpperCase())}</div>
        <div class="grow"><div class="b">${h(u.full_name)} <span class="badge ${u.role === "cashier" ? "gray" : ""}">${h(ROLE[u.role])}</span> ${u.active ? "" : `<span class="badge warn">inactive</span>`}</div><div class="small muted">${h(u.username || "")}</div></div>
        ${u.id !== S.profile.id ? `<button class="btn sm" data-act="user-edit" data-id="${u.id}">Edit</button>` : `<span class="small muted">you</span>`}
      </div>`).join("")}</div>`;
  }
  function userForm(id) {
    const u = id ? S.users.find((x) => x.id === id) : null;
    const owner = S.profile.role === "owner";
    const roles = [["cashier", "Cashier (Android app)"], ...(owner || u?.role === "admin" ? [["admin", "Admin (back office + app)"]] : []), ...(owner ? [["owner", "Owner"]] : [])];
    modal(`<h2>${u ? "Edit user" : "New user"}</h2><form class="col" data-form="user" data-id="${id || ""}">
      <label class="f">Full name<input class="inp" name="full_name" value="${h(u?.full_name || "")}" required autofocus></label>
      ${u ? `<div class="small muted">Username: <b>${h(u.username || "-")}</b></div>` : `<label class="f">Username (for signing in)<input class="inp" name="username" autocapitalize="none" pattern="[a-z0-9._\\-]{3,30}" placeholder="e.g. cashier1" required></label>
      <label class="f">Password<input class="inp" name="password" type="text" minlength="6" required></label>`}
      <label class="f">Role<select class="inp" name="role">${roles.map(([k, l]) => `<option value="${k}" ${u?.role === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${u ? `<label class="row"><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Active (can sign in)</label>` : ""}
      <div class="mfoot">${u ? `<button type="button" class="btn bad" data-act="user-del" data-id="${id}">Delete</button><button type="button" class="btn" data-act="user-pw" data-id="${id}">Reset password</button><span class="grow"></span>` : ""}
        <button type="button" class="btn" data-act="m-close">Cancel</button><button class="btn pri" type="submit">Save</button></div></form>`);
  }
  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch {} throw new Error(m); }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  function sampleReceipt() {
    const st = S.settings, sub = 300000, srv = Math.round(sub * st.service_percent / 100), tax = Math.round((sub + srv) * st.tax_percent / 100);
    return P.buildReceipt({ receipt_no: `${st.receipt_prefix}${today().slice(2).replace(/-/g, "")}-0001`, created_at: new Date(), cashier_name: S.profile.full_name, customer_name: "John Smith",
      subtotal: sub, discount: 0, service_charge: srv, tax, total: sub + srv + tax, payment_method: "Cash", amount_paid: sub + srv + tax, change_amount: 0 },
      [{ name: "Bike Rental (per day)", unit: "day", qty: 2, price: 50000, line_total: 100000, item_ref: "B-07" }, { name: "Massage", unit: "session", qty: 1, price: 200000, line_total: 200000 }], st, { width: 32 });
  }
  function viewStore() {
    const s = S.settings;
    if (S.reportLog === null) { sb.from("report_log").select("*").order("sent_at", { ascending: false }).limit(8).then((r) => { S.reportLog = r.data || []; render(); }); S.reportLog = undefined; }
    const hours = Array.from({ length: 24 }, (_, i) => i);
    return `<div class="grid2 store">
      <div class="col" style="gap:14px">
        <form class="card col" data-form="store">
          <h3>Business</h3>
          <label class="f">Business name<input class="inp" name="business_name" value="${h(s.business_name)}" placeholder="Shown in the app, emails and (optionally) on receipts"></label>
          <label class="f">Address<input class="inp" name="address" value="${h(s.address)}"></label>
          <label class="f">Phone / WhatsApp<input class="inp" name="phone" value="${h(s.phone)}"></label>
          <h3 style="margin-top:8px">Receipt</h3>
          <label class="row"><input type="checkbox" name="receipt_show_name" ${s.receipt_show_name !== false ? "checked" : ""}> Print the business name${s.logo_data ? " under the logo" : ""}</label>
          <label class="f">Text above items (optional)<textarea class="inp" name="receipt_header" rows="2">${h(s.receipt_header)}</textarea></label>
          <label class="f">Thank-you message<textarea class="inp" name="thank_you" rows="2">${h(s.thank_you)}</textarea></label>
          <label class="f">Footer (small print)<textarea class="inp" name="receipt_footer" rows="2">${h(s.receipt_footer)}</textarea></label>
          <label class="f">Receipt number prefix<input class="inp" name="receipt_prefix" value="${h(s.receipt_prefix)}" maxlength="6"></label>
          <h3 style="margin-top:8px">Tax & service charge</h3>
          <div class="grid2" style="gap:10px">
            <label class="f">Service charge name<input class="inp" name="service_label" value="${h(s.service_label)}" maxlength="20"></label>
            <label class="f">Service charge %<input class="inp" name="service_percent" inputmode="decimal" value="${Number(s.service_percent)}"></label>
            <label class="f">Tax name<input class="inp" name="tax_label" value="${h(s.tax_label)}" maxlength="20"></label>
            <label class="f">Tax %<input class="inp" name="tax_percent" inputmode="decimal" value="${Number(s.tax_percent)}"></label>
          </div>
          <div class="small muted">Service is charged on the subtotal after discount; tax on subtotal + service. Use 0 to switch either off.</div>
          <h3 style="margin-top:8px">Card fee</h3>
          <div class="grid2" style="gap:10px">
            <label class="f">Name on receipt<input class="inp" name="card_fee_label" value="${h(s.card_fee_label || "Card fee")}" maxlength="20"></label>
            <label class="f">Fee %<input class="inp" name="card_fee_percent" inputmode="decimal" value="${Number(s.card_fee_percent || 0)}"></label>
            <label class="f">Plus fixed amount (Rp)<input class="inp" name="card_fee_fixed" inputmode="numeric" value="${Number(s.card_fee_fixed || 0)}"></label>
          </div>
          <div class="small muted">Charged on top of the total (after ${h(s.tax_label || "tax")}) only for these payment methods:</div>
          <div class="chips">${s.payment_methods.map((m) => `<label class="chip ${(s.card_fee_methods || []).includes(m) ? "on" : ""}"><input type="checkbox" name="card_fee_methods" value="${h(m)}" ${(s.card_fee_methods || []).includes(m) ? "checked" : ""} style="display:none" data-bind="chipbox"> ${h(m)}</label>`).join("")}</div>
          <div class="small muted">Use 0 % and 0 Rp to switch the card fee off.</div>
          <h3 style="margin-top:8px">Payments</h3>
          <label class="f">Payment methods (comma separated)<input class="inp" name="payment_methods" value="${h(s.payment_methods.join(", "))}"></label>
          <label class="f">Maximum cashier discount (%)<input class="inp" name="max_discount_pct" inputmode="decimal" value="${Number(s.max_discount_pct)}"></label>
          <div class="small muted">"Cash" is used for change and the shift cash count.</div>
          <div class="mfoot"><button class="btn pri" type="submit">Save settings</button></div>
        </form>
        <form class="card col" data-form="email">
          <h3>📧 Daily sales email</h3>
          <label class="row"><input type="checkbox" name="report_enabled" ${s.report_enabled ? "checked" : ""}> Send the daily sales report automatically</label>
          <label class="f">Send at (WITA)<select class="inp" name="report_hour">${hours.map((x) => `<option value="${x}" ${x === Number(s.report_hour) ? "selected" : ""}>${pad(x)}:00</option>`).join("")}</select></label>
          <label class="f">Recipients (one per line or comma separated)<textarea class="inp" name="report_emails" rows="3" placeholder="owner@example.com&#10;manager@example.com">${h(s.report_emails.join("\n"))}</textarea></label>
          <div class="row wrap"><button class="btn pri" type="submit">Save email settings</button><span class="grow"></span>
            <button type="button" class="btn" data-act="email-now" data-d="${addDays(today(), -1)}">Send yesterday's now</button>
            <button type="button" class="btn" data-act="email-now" data-d="${today()}">Send today's now</button></div>
          ${S.reportLog && S.reportLog.length ? `<div class="small muted" style="margin-top:4px">Recent emails</div><div class="list small">${S.reportLog.map((l) => `<div class="li" style="padding:6px 2px">
            <span>${l.ok ? "✅" : "⚠️"}</span><div class="grow">${fmtD(l.day)} report · ${h(l.kind)} · ${fmtDT(l.sent_at)}<div class="muted">${h(l.ok ? l.recipients.join(", ") : l.error || "failed")}</div></div></div>`).join("")}</div>` : ""}
        </form>
      </div>
      <div class="col" style="gap:14px">
        <div class="card col">
          <h3>Receipt logo</h3>
          ${s.logo_data ? `<div class="center" style="padding:10px;background:#fafafa;border-radius:12px"><img src="${h(s.logo_data)}" alt="Logo" style="max-width:220px;max-height:120px"></div>` : `<div class="muted small">No logo yet. A simple black-and-white logo prints best on thermal paper.</div>`}
          <div class="row wrap">
            <label class="btn">${s.logo_data ? "Replace logo" : "Upload logo"}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-bind="logo-file" style="display:none"></label>
            ${s.logo_data ? `<button class="btn bad" data-act="logo-del">Remove</button>` : ""}
          </div>
        </div>
        <div class="card"><h3>Receipt preview</h3>${P.toHtml(sampleReceipt())}</div>
      </div>
    </div>`;
  }
  function processLogo(file) {
    return new Promise((res, rej) => {
      if (file.size > 5e6) return rej(new Error("That image is too big (max 5 MB)"));
      const fr = new FileReader();
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          // trim transparent / white margins so the logo is truly centred
          const W0 = im.naturalWidth || 400, H0 = im.naturalHeight || 200;
          const t = document.createElement("canvas"); t.width = W0; t.height = H0;
          const tg = t.getContext("2d"); tg.drawImage(im, 0, 0);
          const px = tg.getImageData(0, 0, W0, H0).data;
          let x0 = W0, y0 = H0, x1 = -1, y1 = -1;
          for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) {
            const i = (y * W0 + x) * 4;
            if (px[i + 3] > 24 && (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
          const src = x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: W0, h: H0 };
          const w = Math.min(400, src.w), hgt = Math.round(src.h * w / src.w);
          const c = document.createElement("canvas"); c.width = w; c.height = Math.min(hgt, 300);
          const g = c.getContext("2d"); g.drawImage(im, src.x, src.y, src.w, src.h, 0, 0, w, hgt);   // keep transparency (PNG)
          let url = c.toDataURL("image/png");
          if (url.length > 290000) { g.globalCompositeOperation = "destination-over"; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); url = c.toDataURL("image/jpeg", 0.85); }
          if (url.length > 290000) return rej(new Error("Logo is too detailed — try a simpler or smaller image"));
          res(url);
        };
        im.onerror = () => rej(new Error("That file isn't an image we can read"));
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // ───────────────────────── actions ─────────────────────────
  const cartLine = (k) => S.cart.find((l) => l.key === k);
  const ACT = {
    "modal-bg": (el, e) => { if (e.target === el) closeModal(); },
    "m-close": () => closeModal(),
    "auth-mode": (el, e) => { e.preventDefault(); S.authMode = el.dataset.m; render(); },
    logout: async () => { if (await ask("Sign out?", "You'll need your username and password to sign in again.", "Sign out")) await sb.auth.signOut(); },
    recheck: () => run(async () => { await loadProfile(); if (S.profile?.active) await afterLogin(); render(); }),
    go: (el) => {
      S.view = el.dataset.v; S.cartOpen = false;
      ({ tx: () => { S.tx.rows = null; }, rental: () => { S.rentals = null; }, shifts: () => { S.shifts = null; }, dash: () => { S.dash = null; },
         report: () => { S.rep.data = null; }, users: () => { S.users = null; }, store: () => { S.reportLog = null; },
         shift: () => { S.shifts = null; loadShift().then(render).catch(() => {}); },
         pos: () => { loadMaster().then(render).catch(() => {}); }, services: () => { loadMaster().then(render).catch(() => {}); } }[S.view] || (() => {}))();
      render(); window.scrollTo(0, 0);
    },
    cat: (el) => { S.cat = el.dataset.c; render(); },
    add: (el) => { const s = S.services.find((x) => x.id === el.dataset.id); if (s) { addToCart(s); render(); } },
    qty: (el) => { const l = cartLine(el.dataset.k); if (!l) return; l.qty = Math.max(0, (Number(l.qty) || 0) + Number(el.dataset.d)); if (l.qty === 0) S.cart = S.cart.filter((x) => x !== l); render(); },
    del: (el) => { S.cart = S.cart.filter((x) => x.key !== el.dataset.k); render(); },
    dup: (el) => { const l = cartLine(el.dataset.k); if (l) { S.cart.splice(S.cart.indexOf(l) + 1, 0, Object.assign({}, l, { key: Math.random().toString(36).slice(2), item_ref: "" })); render(); } },
    price: async (el, e) => {
      e.preventDefault(); if (!isAdmin()) return toast("Only an admin can change prices (Back office → Services & prices)", true);
      const l = cartLine(el.dataset.k); const v = await prompt("Price for this sale", { label: l.name, value: l.price, type: "number", hint: `Normal price ${rp(l.base)}` });
      if (v !== null && v !== "") { l.price = num(v); render(); }
    },
    "cart-clear": async () => { if (await ask("Clear the cart?", "All items will be removed.", "Clear", true)) { resetSale(); render(); } },
    "cart-open": () => { S.cartOpen = true; render(); window.scrollTo(0, 0); },
    "cart-close": () => { S.cartOpen = false; render(); },
    "disc-mode": (el) => { S.disc.mode = el.dataset.m; render(); },
    method: (el) => { S.pay.method = el.dataset.m; S.pay.paid = ""; render(); },
    paid: (el) => { S.pay.paid = String(Number(el.dataset.v)); render(); },
    checkout: () => checkout(),
    print: (el) => { const t = S.lastTx && S.lastTx.id === el.dataset.id ? S.lastTx : null; if (t) printTx(t, t.status === "void" ? "COPY - VOID" : undefined); },
    wa: (el) => { const t = S.lastTx; if (t && t.id === el.dataset.id) waTx(t); },
    void: async (el) => {
      const reason = await prompt("Void this sale", { label: "Reason (required)", placeholder: "e.g. entered by mistake", okLabel: "Void sale" });
      if (!reason) return;
      const ok = await run(async () => { must(await sb.rpc("void_sale", { p_id: el.dataset.id, p_reason: reason })); return true; }, "Sale voided");
      if (ok) { S.tx.rows = null; render(); const t = await run(() => fetchTx(el.dataset.id)); if (t) showReceipt(t); }
    },
    "tx-open": async (el) => { const t = await run(() => fetchTx(el.dataset.id)); if (t) showReceipt(t); },
    "tx-reload": () => { S.tx.rows = null; render(); },
    "rental-reload": () => { S.rentals = null; render(); },
    "shifts-reload": () => { S.shifts = null; render(); },
    return: async (el) => {
      const r = S.rentals.find((x) => x.id === el.dataset.id);
      if (!(await ask("Has it come back?", `${h(r.name)} ${r.item_ref ? "· " + h(r.item_ref) : ""} — ${h(r.tx.customer_name || "Guest")}`, "Yes, returned"))) return;
      const ok = await run(async () => { must(await sb.rpc("return_rental", { p_item: r.id })); return true; }, "Marked as returned");
      if (ok) { S.rentals = null; render(); }
    },
    "shift-open": async () => {
      const cash = num($("#open-cash").value);
      const ok = await run(async () => { must(await sb.rpc("open_shift", { p_cash: cash })); await loadShift(); return true; }, "Shift opened");
      if (ok) { S.shifts = null; render(); }
    },
    "shift-close": async () => {
      const cash = num($("#close-cash").value), note = $("#close-note").value;
      if (!(await ask("Close shift?", `Cash counted: <b>${rp(cash)}</b>`, "Close shift"))) return;
      const sum = await run(async () => must(await sb.rpc("close_shift", { p_cash: cash, p_note: note })), "Shift closed");
      if (!sum) return;
      S.shift = null; S.shifts = null; render();
      const lines = shiftLines(sum), diff = Number(sum.shift.closing_cash) - Number(sum.shift.expected_cash);
      modal(`<h2>Shift summary</h2><div class="center" style="margin-bottom:10px">Cash difference: <b style="color:${diff < 0 ? "var(--bad)" : "var(--ok)"}">${(diff > 0 ? "+" : "") + rp(diff)}</b></div>${P.toHtml(lines)}
        <div class="mfoot"><button class="btn" data-act="print-lines">🖨 Print</button><button class="btn pri" data-act="m-close">Done</button></div>`);
      S.printLines = lines;
    },
    "print-lines": () => run(() => P.print(S.printLines)),
    "dash-reload": () => { S.dash = null; render(); },
    "rep-preset": (el) => { S.rep.from = el.dataset.a; S.rep.to = el.dataset.b; S.rep.data = null; render(); },
    "rep-csv": () => exportCsv(),
    "rep-print": () => { if (S.rep.data) run(() => P.print(reportLines(), { method: "system" })); },
    "svc-edit": (el) => svcForm(el.dataset.id),
    "cat-edit": (el) => catForm(el.dataset.c),
    "svc-del": async (el) => {
      if (!(await ask("Delete this service?", "Past sales are kept. To just hide it from the cashier app, untick Active instead.", "Delete", true))) return;
      const ok = await run(async () => { must(await sb.from("services").delete().eq("id", el.dataset.id)); await loadMaster(); return true; }, "Service deleted");
      if (ok) render();
    },
    "user-new": () => userForm(null),
    "user-edit": (el) => userForm(el.dataset.id),
    "user-pw": async (el) => {
      const pw = await prompt("Reset password", { label: "New password (at least 6 characters)", okLabel: "Reset" });
      if (pw) await run(() => callFn("admin-users", { action: "set_password", user_id: el.dataset.id, password: pw }), "Password changed");
    },
    "user-del": async (el) => {
      if (!(await ask("Delete this user?", "If they have made sales, the account is deactivated instead so the history stays complete.", "Delete", true))) return;
      const r = await run(() => callFn("admin-users", { action: "delete", user_id: el.dataset.id }));
      if (r) { toast(r.deactivated ? "User deactivated" : "User deleted"); closeModal(); S.users = null; render(); }
    },
    "logo-del": async () => {
      if (!(await ask("Remove the logo?", "Receipts will print without a logo.", "Remove", true))) return;
      const ok = await run(async () => { must(await sb.from("settings").update({ logo_data: "" }).eq("id", 1)); await loadMaster(); return true; }, "Logo removed");
      if (ok) render();
    },
    "email-now": async (el) => {
      const day = el.dataset.d;
      const r = await run(() => callFn("daily-report", { day }));
      if (r) { toast(`Report for ${fmtD(day)} sent to ${r.recipients.length} address${r.recipients.length === 1 ? "" : "es"}`); }
      S.reportLog = null; render();
    },
    "pr-pick": async () => {
      const devs = await run(() => P.listPaired()); if (!devs) return;
      modal(`<h2>Choose printer</h2><div class="list">${devs.map((d) => `<div class="li" data-act="pr-set" data-a="${h(d.address)}" data-n="${h(d.name || d.address)}" style="cursor:pointer"><span style="font-size:22px">🖨</span><div class="grow"><div class="b">${h(d.name || "(no name)")}</div><div class="small muted">${h(d.address)}</div></div></div>`).join("") || `<div class="empty">No paired devices. Pair the printer in Android Bluetooth settings first.</div>`}</div><div class="mfoot"><button class="btn" data-act="m-close">Close</button></div>`);
    },
    "pr-set": (el) => { P.setCfg({ address: el.dataset.a, name: el.dataset.n, method: "native" }); closeModal(); render(); toast("Printer selected: " + el.dataset.n); },
    "pr-ble": () => run(async () => { await P.webConnect(true); P.setCfg({ method: "webbt" }); render(); }, "Printer connected"),
    "pr-test": () => run(() => P.print(P.testLines(S.settings))),
    "my-pw": async () => {
      const pw = await prompt("Change password", { label: "New password (at least 6 characters)", type: "password" });
      if (pw) await run(async () => { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; }, "Password changed");
    },
  };

  const BIND = {
    qty: (el) => { const l = cartLine(el.dataset.k); if (l) { l.qty = el.value === "" ? "" : dec(el.value); refreshTotals(); const amt = el.closest(".ci").querySelector(".t > .b"); if (amt) amt.textContent = rp(Math.round(l.price * (Number(l.qty) || 0))); } },
    ref: (el) => { const l = cartLine(el.dataset.k); if (l) l.item_ref = el.value; },
    cust: (el) => { S.cust[el.dataset.f] = el.value; },
    disc: (el) => { S.disc.v = el.value; refreshTotals(); },
    paid: (el) => { S.pay.paid = el.value.replace(/[^\d]/g, ""); refreshTotals(); },
    "tx-q": (el) => { S.tx.q = el.value; clearTimeout(BIND._t); BIND._t = setTimeout(() => { render(); const i = $('[data-bind="tx-q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); },
  };
  const CHANGE = {
    "tx-from": (el) => { S.tx.from = el.value || today(); S.tx.rows = null; render(); },
    "tx-to": (el) => { S.tx.to = el.value || today(); S.tx.rows = null; render(); },
    "rep-from": (el) => { S.rep.from = el.value; S.rep.data = null; render(); },
    "rep-to": (el) => { S.rep.to = el.value; S.rep.data = null; render(); },
    qty: () => render(),
    pr: (el) => { const f = el.dataset.f; P.setCfg({ [f]: el.type === "checkbox" ? el.checked : (f === "width" || f === "copies" ? Number(el.value) : el.value) }); render(); },
    chipbox: (el) => { el.closest(".chip").classList.toggle("on", el.checked); },
    "logo-file": async (el) => {
      const file = el.files && el.files[0]; if (!file) return;
      const ok = await run(async () => { const url = await processLogo(file); must(await sb.from("settings").update({ logo_data: url }).eq("id", 1)); await loadMaster(); return true; }, "Logo saved");
      if (ok) render();
    },
  };

  const FORMS = {
    login: async (fd) => {
      let user = String(fd.get("user")).trim().toLowerCase();
      if (!user.includes("@")) user = `${user}@${C.usernameDomain}`;
      await run(async () => { const { error } = await sb.auth.signInWithPassword({ email: user, password: fd.get("password") }); if (error) throw new Error(error.message === "Invalid login credentials" ? "Wrong username/email or password" : error.message); });
    },
    register: async (fd) => {
      const user = String(fd.get("user")).trim().toLowerCase();
      if (!user.includes("@")) return toast("Use a real email address — we send a confirmation link.", true);
      await run(async () => {
        const { data, error } = await sb.auth.signUp({ email: user, password: fd.get("password"), options: { data: { full_name: fd.get("full_name") }, emailRedirectTo: C.webUrl } });
        if (error) throw error;
        if (!data.session) { S.authMode = "login"; render(); modal(`<h2>Check your email 📧</h2><div class="muted">We sent a confirmation link to <b>${h(user)}</b>. Click it, then come back and sign in with your email and password.</div><div class="mfoot"><button class="btn pri" data-act="m-close">OK</button></div>`); }
      });
    },
    svc: async (fd, form) => {
      const id = form.dataset.id;
      const row = { category: fd.get("category"), name: String(fd.get("name")).trim(), price: num(fd.get("price")), unit: fd.get("unit"),
        duration_hours: fd.get("duration_hours") ? dec(fd.get("duration_hours")) : null, sort: Math.round(dec(fd.get("sort"))), description: String(fd.get("description")).trim(), active: fd.get("active") === "on" };
      const ok = await run(async () => { must(id ? await sb.from("services").update(row).eq("id", id) : await sb.from("services").insert(row)); await loadMaster(); return true; }, "Service saved");
      if (ok) { closeModal(); render(); }
    },
    cat: async (fd, form) => {
      const code = form.dataset.c;
      const row = { name: String(fd.get("name")).trim(), icon: fd.get("icon") || "🛎️", color: fd.get("color"), sort: Math.round(dec(fd.get("sort"))), is_rental: fd.get("is_rental") === "on", active: fd.get("active") === "on" };
      const ok = await run(async () => { must(code ? await sb.from("categories").update(row).eq("code", code) : await sb.from("categories").insert(Object.assign(row, { code: String(fd.get("code")).trim() }))); await loadMaster(); return true; }, "Category saved");
      if (ok) { closeModal(); render(); }
    },
    user: async (fd, form) => {
      const id = form.dataset.id;
      const ok = await run(async () => {
        if (id) must(await sb.from("profiles").update({ full_name: String(fd.get("full_name")).trim(), role: fd.get("role"), active: fd.get("active") === "on" }).eq("id", id));
        else await callFn("admin-users", { action: "create", full_name: String(fd.get("full_name")).trim(), username: String(fd.get("username")).trim().toLowerCase(), password: fd.get("password"), role: fd.get("role") });
        return true;
      }, "User saved");
      if (ok) { closeModal(); S.users = null; render(); }
    },
    store: async (fd) => {
      const t = (k) => String(fd.get(k) ?? "").trim();
      const row = { business_name: t("business_name"), receipt_show_name: fd.get("receipt_show_name") === "on", address: t("address"), phone: t("phone"), receipt_header: String(fd.get("receipt_header")), thank_you: String(fd.get("thank_you")),
        receipt_footer: String(fd.get("receipt_footer")), receipt_prefix: t("receipt_prefix").toUpperCase() || "PX",
        service_label: t("service_label") || "Service", service_percent: dec(fd.get("service_percent")), tax_label: t("tax_label") || "Tax", tax_percent: dec(fd.get("tax_percent")),
        card_fee_label: t("card_fee_label") || "Card fee", card_fee_percent: dec(fd.get("card_fee_percent")), card_fee_fixed: num(fd.get("card_fee_fixed")),
        card_fee_methods: fd.getAll("card_fee_methods").map(String),
        max_discount_pct: dec(fd.get("max_discount_pct")), payment_methods: t("payment_methods").split(",").map((s) => s.trim()).filter(Boolean) };
      if (!row.payment_methods.length) return toast("Add at least one payment method", true);
      row.card_fee_methods = row.card_fee_methods.filter((m) => row.payment_methods.includes(m));
      if (row.service_percent > 100 || row.tax_percent > 100 || row.card_fee_percent > 100) return toast("Percentages must be between 0 and 100", true);
      const ok = await run(async () => { must(await sb.from("settings").update(row).eq("id", 1)); await loadMaster(); return true; }, "Settings saved");
      if (ok) render();
    },
    email: async (fd) => {
      const list = String(fd.get("report_emails")).split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      const bad = list.filter((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
      if (bad.length) return toast("Not a valid email: " + bad.join(", "), true);
      if (list.length > 20) return toast("Maximum 20 recipients", true);
      const enabled = fd.get("report_enabled") === "on";
      if (enabled && !list.length) return toast("Add at least one recipient", true);
      const ok = await run(async () => { must(await sb.from("settings").update({ report_enabled: enabled, report_hour: Number(fd.get("report_hour")), report_emails: [...new Set(list)] }).eq("id", 1)); await loadMaster(); return true; }, "Email settings saved");
      if (ok) render();
    },
  };

  document.addEventListener("click", (e) => { const el = e.target.closest("[data-act]"); if (!el) return; const f = ACT[el.dataset.act]; if (f) f(el, e); });
  document.addEventListener("input", (e) => { const el = e.target.closest("[data-bind]"); if (el && BIND[el.dataset.bind]) BIND[el.dataset.bind](el, e); });
  document.addEventListener("change", (e) => { const el = e.target.closest("[data-bind]"); if (el && CHANGE[el.dataset.bind]) CHANGE[el.dataset.bind](el, e); });
  document.addEventListener("submit", (e) => { const form = e.target.closest("[data-form]"); if (!form) return; e.preventDefault(); const f = FORMS[form.dataset.form]; if (f) f(new FormData(form), form); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#modal-root").innerHTML) closeModal(); });
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener) CapApp.addListener("backButton", () => {
    if ($("#modal-root").innerHTML) closeModal();
    else if (S.cartOpen) { S.cartOpen = false; render(); }
    else if (S.session && S.view !== "pos") ACT.go({ dataset: { v: "pos" } });
    else CapApp.minimizeApp ? CapApp.minimizeApp() : CapApp.exitApp();
  });

  // ───────────────────────── boot ─────────────────────────
  async function afterLogin() {
    await loadMaster();
    if (!BO) await loadShift().catch(() => { S.shift = null; });
  }
  async function onSession(session) {
    const prevUser = S.session && S.session.user.id;
    S.session = session;
    if (!session) { S.profile = null; S.settings = null; S.view = BO ? "dash" : "pos"; render(); return; }
    if (prevUser === session.user.id && S.profile) return;
    render();
    try { await loadProfile(); if (S.profile && S.profile.active && (!BO || isAdmin())) await afterLogin(); }
    catch (e) { toast(errMsg(e), true); }
    render();
  }
  if (C.supabaseUrl.startsWith("__")) { $("#app").innerHTML = `<div class="boot"><div class="logo-mark">PX</div><div>Supabase is not configured (js/config.js).</div></div>`; return; }
  sb.auth.onAuthStateChange((_ev, session) => { setTimeout(() => onSession(session), 0); });
  if ("serviceWorker" in navigator && !P.isNative() && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
