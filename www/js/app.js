/* PX POS — cashier + backoffice (single-page app, Supabase backend) */
(function () {
  "use strict";
  const C = window.PX_CONFIG, P = window.PXPrinter;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // ───────────────────────── state ─────────────────────────
  const S = {
    session: null, profile: null, settings: null, cats: [], services: [],
    view: "pos", cat: "all", cart: [], cust: { name: "", phone: "", note: "" },
    disc: { mode: "rp", v: "" }, pay: { method: "Cash", paid: "" }, cartOpen: false,
    shift: undefined, busy: false,
    tx: { from: today(), to: today(), q: "", rows: null },
    rentals: null, shifts: null,
    bo: { tab: "dash", from: monthStart(), to: today(), report: null, dash: null, users: null },
    authMode: "login",
  };

  // ───────────────────────── helpers ─────────────────────────
  const $ = (s, r = document) => r.querySelector(s);
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rp = (n) => "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");
  const num = (v) => { const n = Number(String(v ?? "").replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
  const pad = (n) => String(n).padStart(2, "0");
  function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function monthStart() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; }
  const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayStartISO = (iso) => new Date(iso + "T00:00:00").toISOString();
  const dayEndISO = (iso) => new Date(addDays(iso, 1) + "T00:00:00").toISOString();
  const fmtDT = (d) => P.fmtDT(d);
  const fmtT = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
  const fmtD = (iso) => { const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : "")); return d.toLocaleDateString("id-ID", { day: "numeric", month: "short" }); };
  const isAdmin = () => S.profile && ["owner", "admin"].includes(S.profile.role) && S.profile.active;
  const catOf = (code) => S.cats.find((c) => c.code === code) || { name: code, icon: "🛎️", color: "#0f766e", is_rental: false };
  const UNIT = P.UNIT;
  const REF_HINT = { rent_bike: "No. sepeda", ebike: "No. e-bike", massage: "Nama terapis", snorkeling: "Guide / jml orang", laundry: "No. tag laundry" };
  const errMsg = (e) => { const m = (e && (e.message || e.error_description || e.error)) || String(e); return m.replace(/^.*?ERROR:\s*/, ""); };

  function toast(msg, bad) {
    const el = document.createElement("div");
    el.className = "tm" + (bad ? " bad" : ""); el.textContent = msg;
    $("#toast").appendChild(el); setTimeout(() => el.remove(), bad ? 4500 : 2600);
  }
  async function run(fn, okMsg) {
    if (S.busy) return; S.busy = true; document.body.style.cursor = "progress";
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { console.error(e); toast(errMsg(e), true); }
    finally { S.busy = false; document.body.style.cursor = ""; }
  }
  const must = ({ data, error }) => { if (error) throw error; return data; };

  // modal
  let modalOnClose = null;
  function modal(html, { wide = false, onClose = null } = {}) {
    modalOnClose = onClose;
    $("#modal-root").innerHTML = `<div class="mbg" data-act="modal-bg"><div class="modal${wide ? " wide" : ""}" role="dialog">${html}</div></div>`;
    const f = $("#modal-root [autofocus]"); if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal() { $("#modal-root").innerHTML = ""; const f = modalOnClose; modalOnClose = null; if (f) f(); }
  function ask(title, body, okLabel = "Ya", bad = false) {
    return new Promise((res) => {
      modal(`<h2>${h(title)}</h2><div class="muted">${body}</div><div class="mfoot"><button class="btn" data-act="m-no">Batal</button><button class="btn ${bad ? "bad" : "pri"}" data-act="m-yes" autofocus>${h(okLabel)}</button></div>`, { onClose: () => res(false) });
      ACT["m-yes"] = () => { modalOnClose = null; closeModal(); res(true); };
      ACT["m-no"] = () => closeModal();
    });
  }
  function prompt(title, { label = "", value = "", type = "text", placeholder = "", okLabel = "Simpan", hint = "" } = {}) {
    return new Promise((res) => {
      modal(`<h2>${h(title)}</h2><label class="f">${h(label)}<input class="inp" id="pr-in" type="${type}" value="${h(value)}" placeholder="${h(placeholder)}" autofocus ${type === "number" ? 'inputmode="decimal"' : ""}></label>${hint ? `<div class="small muted" style="margin-top:6px">${hint}</div>` : ""}<div class="mfoot"><button class="btn" data-act="m-no">Batal</button><button class="btn pri" data-act="m-yes">${h(okLabel)}</button></div>`, { onClose: () => res(null) });
      const go = () => { const v = $("#pr-in").value; modalOnClose = null; closeModal(); res(v); };
      ACT["m-yes"] = go; ACT["m-no"] = () => closeModal();
      $("#pr-in").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    });
  }

  // ───────────────────────── data ─────────────────────────
  async function loadProfile() {
    const uid = S.session.user.id;
    S.profile = must(await sb.from("profiles").select("*").eq("id", uid).maybeSingle());
  }
  async function loadMaster() {
    const [st, cats, svcs] = await Promise.all([
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("categories").select("*").order("sort").order("name"),
      sb.from("services").select("*").order("sort").order("name"),
    ]);
    S.settings = must(st); S.cats = must(cats); S.services = must(svcs);
    if (!S.settings.payment_methods.includes(S.pay.method)) S.pay.method = S.settings.payment_methods[0] || "Cash";
  }
  async function loadShift() {
    S.shift = must(await sb.rpc("shift_summary")) || null;
  }
  async function fetchTx(id) {
    const t = must(await sb.from("transactions").select("*, cashier:profiles!transactions_cashier_id_fkey(full_name), items:transaction_items(*)").eq("id", id).single());
    t.cashier_name = t.cashier && t.cashier.full_name;
    t.items.sort((a, b) => (a.start_at || "").localeCompare(b.start_at || "") || a.name.localeCompare(b.name));
    return t;
  }

  // ───────────────────────── cart maths ─────────────────────────
  function totals() {
    const sub = S.cart.reduce((a, l) => a + Math.round(l.price * (Number(l.qty) || 0)), 0);
    let disc = S.disc.mode === "pct" ? Math.round(sub * Math.min(100, num(S.disc.v)) / 100) : Math.round(num(S.disc.v));
    disc = Math.max(0, Math.min(disc, sub));
    const taxPct = Number(S.settings?.tax_percent) || 0;
    const tax = Math.round((sub - disc) * taxPct / 100);
    const total = sub - disc + tax;
    const paid = S.pay.method === "Cash" ? (S.pay.paid === "" ? total : num(S.pay.paid)) : total;
    return { sub, disc, tax, taxPct, total, paid, change: paid - total };
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

  // ───────────────────────── render: shell ─────────────────────────
  const NAV = () => [
    ["pos", "🧾", "Kasir"], ["tx", "📋", "Transaksi"], ["rental", "🚲", "Rental"], ["shift", "⏱️", "Shift"],
    ...(isAdmin() ? [["bo", "📊", "Backoffice"]] : []), ["set", "⚙️", "Setelan"],
  ];
  function render() {
    const app = $("#app");
    if (!S.session) { app.innerHTML = viewLogin(); return; }
    if (!S.profile || !S.profile.active) { app.innerHTML = viewPending(); return; }
    if (!S.settings) { app.innerHTML = `<div class="boot"><div class="logo-mark">PX</div><div class="muted">Memuat data…</div></div>`; return; }
    const nav = NAV();
    const body = { pos: viewPOS, tx: viewTx, rental: viewRental, shift: viewShift, bo: viewBO, set: viewSettings }[S.view] || viewPOS;
    const scroll = window.scrollY;
    app.innerHTML = `
      <header class="top">
        <div class="logo-mark">PX</div>
        <div><div class="brand">${h(S.settings.business_name || "PX POS")}</div><div class="small muted">${h(S.profile.full_name)} · ${h(S.profile.role)}</div></div>
        <nav class="nav">${nav.map(([k, i, l]) => `<a class="${S.view === k ? "on" : ""}" data-act="go" data-v="${k}"><span>${i}</span>${l}</a>`).join("")}</nav>
        <div class="grow"></div>
        ${S.shift ? `<span class="badge hide-m">Shift buka ${fmtT(S.shift.shift.opened_at)}</span>` : `<span class="badge warn hide-m">Shift belum dibuka</span>`}
      </header>
      <main class="page">${body()}</main>
      <nav class="bnav">${nav.map(([k, i, l]) => `<a class="${S.view === k ? "on" : ""}" data-act="go" data-v="${k}"><span class="i">${i}</span>${l}</a>`).join("")}</nav>`;
    if (S.view === "pos") window.scrollTo(0, scroll);
  }

  function viewLogin() {
    const reg = S.authMode === "register";
    return `<div class="login"><form class="card col" data-form="${reg ? "register" : "login"}" autocomplete="on">
      <div class="row"><div class="logo-mark">PX</div><div><div class="b" style="font-size:20px">PX POS</div><div class="muted small">Kasir & Backoffice</div></div></div>
      ${reg ? `<label class="f">Nama lengkap<input class="inp" name="full_name" required></label>` : ""}
      <label class="f">${reg ? "Email" : "Username atau email"}<input class="inp" name="user" ${reg ? 'type="email"' : ""} autocomplete="${reg ? "email" : "username"}" autocapitalize="none" required></label>
      <label class="f">Password<input class="inp" name="password" type="password" autocomplete="${reg ? "new-password" : "current-password"}" required minlength="6"></label>
      <button class="btn pri lg" type="submit">${reg ? "Buat akun" : "Masuk"}</button>
      <div class="small muted center">${reg
        ? `Akun pertama otomatis jadi <b>Owner</b>. Akun berikutnya menunggu diaktifkan admin. <a href="#" data-act="auth-mode" data-m="login">Sudah punya akun?</a>`
        : `Akun kasir dibuat oleh admin di Backoffice. <a href="#" data-act="auth-mode" data-m="register">Daftar akun baru</a>`}</div>
    </form></div>`;
  }
  function viewPending() {
    return `<div class="login"><div class="card col center">
      <div class="logo-mark" style="margin:0 auto">PX</div>
      <h3 style="margin:6px 0 0">Akun menunggu aktivasi</h3>
      <div class="muted">Halo ${h(S.profile?.full_name || S.session.user.email)}, akun kamu belum aktif. Minta owner/admin mengaktifkan di Backoffice → Pengguna.</div>
      <button class="btn" data-act="recheck">Cek lagi</button><button class="btn ghost" data-act="logout">Keluar</button>
    </div></div>`;
  }

  // ───────────────────────── render: POS ─────────────────────────
  function viewPOS() {
    const cats = S.cats.filter((c) => c.active);
    const svcs = S.services.filter((s) => s.active && catOf(s.category).active !== false && (S.cat === "all" || s.category === S.cat));
    const qtyBy = {}; S.cart.forEach((l) => { qtyBy[l.service_id] = (qtyBy[l.service_id] || 0) + (Number(l.qty) || 0); });
    const t = totals();
    const count = S.cart.length;
    return `
      ${!S.shift ? `<div class="card row wrap" style="margin-bottom:12px;background:#fff7ea"><div class="grow">⚠️ <b>Shift belum dibuka.</b> <span class="muted">Buka shift supaya kas bisa direkap saat tutup.</span></div><button class="btn sm pri" data-act="go" data-v="shift">Buka shift</button></div>` : ""}
      <div class="pos">
        <section>
          <div class="cats">
            <button class="cat ${S.cat === "all" ? "on" : ""}" data-act="cat" data-c="all"><span class="ic">✨</span>Semua</button>
            ${cats.map((c) => `<button class="cat ${S.cat === c.code ? "on" : ""}" style="--c:${h(c.color)}" data-act="cat" data-c="${h(c.code)}"><span class="ic">${h(c.icon)}</span>${h(c.name)}</button>`).join("")}
          </div>
          <div class="svcs">
            ${svcs.map((s) => { const c = catOf(s.category); return `
              <div class="svc" style="--c:${h(c.color)}" data-act="add" data-id="${s.id}">
                ${qtyBy[s.id] ? `<span class="qty">${qtyBy[s.id] % 1 ? qtyBy[s.id].toLocaleString("id-ID") : qtyBy[s.id]}</span>` : ""}
                <span class="ic">${h(c.icon)}</span>
                <span class="nm">${h(s.name)}</span>
                ${s.description ? `<span class="small muted">${h(s.description)}</span>` : ""}
                <span class="pr">${rp(s.price)} <span class="small muted">/ ${UNIT[s.unit] || s.unit}</span></span>
              </div>`; }).join("") || `<div class="empty">Belum ada layanan. ${isAdmin() ? "Tambah di Backoffice → Layanan & Harga." : ""}</div>`}
          </div>
        </section>
        <aside class="card cart ${S.cartOpen ? "open" : ""}" id="cart">${cartHtml(t)}</aside>
      </div>
      ${count ? `<div class="cartbar" data-act="cart-open"><span>🛒 ${count} item</span><span class="grow"></span><span>${rp(t.total)}</span><span>›</span></div>` : ""}`;
  }

  function cartHtml(t = totals()) {
    const methods = S.settings.payment_methods;
    const cash = S.pay.method === "Cash";
    const quick = [...new Set([t.total, ...[50000, 100000, 200000, 500000, 1000000, 2000000].filter((v) => v > t.total).slice(0, 3)])];
    return `
      <div class="row"><h3 class="grow" style="margin:0">Keranjang</h3>
        ${S.cart.length ? `<button class="btn sm ghost bad" data-act="cart-clear">Kosongkan</button>` : ""}
        <button class="btn sm ghost" data-act="cart-close" style="${S.cartOpen ? "" : "display:none"}">✕ Tutup</button></div>
      <div class="cart-items">
        ${S.cart.map((l) => { const c = catOf(l.category); return `
          <div class="ci">
            <div class="t"><span>${h(c.icon)}</span><div class="grow"><div class="b">${h(l.name)}</div>
              <div class="small muted"><a href="#" data-act="price" data-k="${l.key}" style="color:inherit">${rp(l.price)}</a> / ${UNIT[l.unit] || l.unit}${l.price !== l.base ? ` <span class="badge warn">harga diubah</span>` : ""}</div></div>
              <div class="b">${rp(Math.round(l.price * (Number(l.qty) || 0)))}</div></div>
            <div class="ctrl">
              <button class="step" data-act="qty" data-k="${l.key}" data-d="-1">−</button>
              <input class="inp q" style="width:64px;min-height:36px;padding:4px;text-align:center" inputmode="decimal" value="${h(l.qty)}" data-bind="qty" data-k="${l.key}">
              <button class="step" data-act="qty" data-k="${l.key}" data-d="1">+</button>
              <span class="small muted">${UNIT[l.unit] || l.unit}</span>
              <span class="grow"></span>
              ${c.is_rental ? `<button class="btn sm" data-act="dup" data-k="${l.key}" title="Tambah unit">+ unit</button>` : ""}
              <button class="btn sm ghost bad" data-act="del" data-k="${l.key}">🗑</button>
            </div>
            <input class="inp" style="margin-top:8px;min-height:38px" placeholder="${h(REF_HINT[l.category] || "Keterangan")}" value="${h(l.item_ref)}" data-bind="ref" data-k="${l.key}">
          </div>`; }).join("") || `<div class="empty">Tap layanan untuk menambahkan.</div>`}
      </div>
      ${S.cart.length ? `
      <div class="col" style="gap:8px">
        <div class="grid2" style="gap:8px">
          <input class="inp" placeholder="Nama tamu" value="${h(S.cust.name)}" data-bind="cust" data-f="name">
          <input class="inp" placeholder="No. HP / WA" inputmode="tel" value="${h(S.cust.phone)}" data-bind="cust" data-f="phone">
        </div>
        <input class="inp" placeholder="Kamar / hotel / catatan" value="${h(S.cust.note)}" data-bind="cust" data-f="note">
        <div class="row" style="gap:6px">
          <input class="inp grow" placeholder="Diskon" inputmode="decimal" value="${h(S.disc.v)}" data-bind="disc">
          <button class="chip ${S.disc.mode === "rp" ? "on" : ""}" data-act="disc-mode" data-m="rp">Rp</button>
          <button class="chip ${S.disc.mode === "pct" ? "on" : ""}" data-act="disc-mode" data-m="pct">%</button>
        </div>
      </div>
      <div class="totals" id="totals">${totalsHtml(t)}</div>
      <div class="chips" style="margin-top:10px">${methods.map((m) => `<button class="chip ${S.pay.method === m ? "on" : ""}" data-act="method" data-m="${h(m)}">${h(m)}</button>`).join("")}</div>
      ${cash ? `
        <label class="f" style="margin-top:10px">Uang diterima<input class="inp" inputmode="numeric" placeholder="${h(t.total.toLocaleString("id-ID"))}" value="${h(S.pay.paid)}" data-bind="paid"></label>
        <div class="chips" style="margin-top:8px">${quick.map((v) => `<button class="chip" data-act="paid" data-v="${v}">${v === t.total ? "Uang pas" : (v / 1000).toLocaleString("id-ID") + "k"}</button>`).join("")}</div>` : ""}
      <button class="btn pri lg" style="width:100%;margin-top:12px" data-act="checkout" id="btn-pay" ${t.change < 0 ? "disabled" : ""}>Bayar ${rp(t.total)}</button>` : ""}`;
  }
  function totalsHtml(t) {
    return `<div class="row"><span class="grow muted">Subtotal</span><span>${rp(t.sub)}</span></div>
      ${t.disc ? `<div class="row"><span class="grow muted">Diskon</span><span>− ${rp(t.disc)}</span></div>` : ""}
      ${t.taxPct ? `<div class="row"><span class="grow muted">Pajak ${t.taxPct}%</span><span>${rp(t.tax)}</span></div>` : ""}
      <div class="row"><span class="grow b">Total</span><span class="grand">${rp(t.total)}</span></div>
      ${S.pay.method === "Cash" && S.pay.paid !== "" ? `<div class="row"><span class="grow muted">Kembalian</span><span class="b" style="color:${t.change < 0 ? "var(--bad)" : "var(--ok)"}">${t.change < 0 ? "Kurang " + rp(-t.change) : rp(t.change)}</span></div>` : ""}`;
  }
  function refreshTotals() {
    const t = totals();
    const el = $("#totals"); if (el) el.innerHTML = totalsHtml(t);
    const b = $("#btn-pay"); if (b) { b.textContent = "Bayar " + rp(t.total); b.disabled = t.change < 0; }
    const bar = $(".cartbar span:nth-child(3)"); if (bar) bar.textContent = rp(t.total);
  }
  function rerenderCart() { render(); }

  async function checkout() {
    const t = totals();
    if (!S.cart.length) return;
    if (S.cart.some((l) => !(Number(l.qty) > 0))) return toast("Jumlah item harus lebih dari 0", true);
    if (t.change < 0) return toast("Uang diterima kurang", true);
    const payload = {
      customer_name: S.cust.name.trim(), customer_phone: S.cust.phone.trim(), customer_note: S.cust.note.trim(),
      discount: t.disc, payment_method: S.pay.method, amount_paid: t.paid,
      items: S.cart.map((l) => Object.assign({ service_id: l.service_id, qty: Number(l.qty), item_ref: l.item_ref.trim(), note: l.note },
        l.price !== l.base ? { price: l.price } : {})),
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
    const canVoid = isAdmin() && tx.status === "paid";
    modal(`
      ${fresh ? `<div class="center" style="margin-bottom:10px"><div style="font-size:40px">✅</div><div class="b" style="font-size:18px">Pembayaran berhasil</div>
        ${Number(tx.change_amount) ? `<div class="muted">Kembalian</div><div class="b" style="font-size:28px;color:var(--pri)">${rp(tx.change_amount)}</div>` : ""}</div>` :
        `<h2>${h(tx.receipt_no)} ${tx.status === "void" ? `<span class="badge bad">VOID</span>` : ""}</h2>`}
      ${tx.status === "void" ? `<div class="small" style="color:var(--bad);margin-bottom:8px">Void oleh admin: ${h(tx.void_reason || "")}</div>` : ""}
      ${P.toHtml(lines)}
      <div class="mfoot">
        ${canVoid && !fresh ? `<button class="btn bad" data-act="void" data-id="${tx.id}">Void</button>` : ""}
        <span class="grow"></span>
        <button class="btn" data-act="wa" data-id="${tx.id}">WhatsApp</button>
        <button class="btn" data-act="print" data-id="${tx.id}">🖨 Cetak</button>
        <button class="btn pri" data-act="m-close">${fresh ? "Transaksi baru" : "Tutup"}</button>
      </div>`);
    S.lastTx = tx;
  }
  async function printTx(tx, copyLabel) {
    const lines = P.buildReceipt(tx, tx.items, S.settings, { copyLabel });
    await run(async () => { const m = await P.print(lines); if (m !== "system" && m !== "rawbt") toast("Struk dicetak"); });
  }
  function waTx(tx) {
    const lines = P.buildReceipt(tx, tx.items, S.settings, { width: 32 });
    const text = "```\n" + lines.map((l) => l.align === "center" ? l.t.padStart(Math.floor((32 + l.t.length) / 2)) : l.t).join("\n") + "\n```";
    let phone = String(tx.customer_phone || "").replace(/\D/g, "");
    if (phone.startsWith("0")) phone = "62" + phone.slice(1);
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    if (P.isNative()) window.location.href = url; else window.open(url, "_blank");
  }

  // ───────────────────────── render: transactions ─────────────────────────
  async function loadTx() {
    let q = sb.from("transactions").select("*, cashier:profiles!transactions_cashier_id_fkey(full_name), items:transaction_items(*)")
      .gte("created_at", dayStartISO(S.tx.from)).lt("created_at", dayEndISO(S.tx.to)).order("created_at", { ascending: false }).limit(500);
    S.tx.rows = must(await q).map((t) => Object.assign(t, { cashier_name: t.cashier && t.cashier.full_name }));
  }
  function viewTx() {
    if (S.tx.rows === null) { loadTx().then(render).catch((e) => toast(errMsg(e), true)); return `<div class="empty">Memuat transaksi…</div>`; }
    const q = S.tx.q.trim().toLowerCase();
    const rows = S.tx.rows.filter((t) => !q || [t.receipt_no, t.customer_name, t.customer_phone, t.customer_note, ...t.items.map((i) => i.name + " " + i.item_ref)].join(" ").toLowerCase().includes(q));
    const paid = rows.filter((t) => t.status === "paid");
    return `
      <div class="card" style="margin-bottom:12px"><div class="row wrap">
        <label class="f">Dari<input class="inp" type="date" value="${S.tx.from}" data-bind="tx-from"></label>
        <label class="f">Sampai<input class="inp" type="date" value="${S.tx.to}" data-bind="tx-to"></label>
        <label class="f grow" style="min-width:180px">Cari<input class="inp" placeholder="No. struk, nama tamu, no. sepeda…" value="${h(S.tx.q)}" data-bind="tx-q"></label>
        <button class="btn" data-act="tx-reload" style="align-self:flex-end">↻</button>
      </div>
      <div class="row small muted" style="margin-top:10px"><span>${paid.length} transaksi</span><span class="grow"></span><span class="b" style="color:var(--ink)">${rp(paid.reduce((a, t) => a + Number(t.total), 0))}</span></div></div>
      <div class="card list">
        ${rows.map((t) => `<div class="li" data-act="tx-open" data-id="${t.id}" style="cursor:pointer">
          <div style="font-size:22px">${h(catOf(t.items[0]?.category).icon)}</div>
          <div class="grow"><div class="b">${h(t.receipt_no)} ${t.status === "void" ? `<span class="badge bad">VOID</span>` : ""}</div>
            <div class="small muted">${fmtDT(t.created_at)} · ${h(t.customer_name || "Tamu")} · ${h(t.items.map((i) => i.name).join(", "))}</div></div>
          <div class="right"><div class="b" style="${t.status === "void" ? "text-decoration:line-through;color:var(--muted)" : ""}">${rp(t.total)}</div><div class="small muted">${h(t.payment_method)}</div></div>
        </div>`).join("") || `<div class="empty">Tidak ada transaksi.</div>`}
      </div>`;
  }

  // ───────────────────────── render: rentals ─────────────────────────
  async function loadRentals() {
    S.rentals = must(await sb.from("transaction_items").select("*, tx:transactions(receipt_no, customer_name, customer_phone, customer_note, status)")
      .eq("rental_status", "out").order("due_at", { ascending: true }));
  }
  function viewRental() {
    if (S.rentals === null) { loadRentals().then(render).catch((e) => toast(errMsg(e), true)); return `<div class="empty">Memuat rental…</div>`; }
    const now = Date.now();
    const rows = S.rentals.filter((r) => r.tx && r.tx.status === "paid");
    const late = rows.filter((r) => r.due_at && new Date(r.due_at).getTime() < now);
    return `
      <div class="kpis" style="margin-bottom:12px">
        <div class="kpi"><div class="muted small">Sedang disewa</div><div class="v">${rows.length}</div></div>
        <div class="kpi"><div class="muted small">Terlambat kembali</div><div class="v" style="color:${late.length ? "var(--bad)" : "inherit"}">${late.length}</div></div>
        ${S.cats.filter((c) => c.is_rental).map((c) => `<div class="kpi"><div class="muted small">${h(c.icon)} ${h(c.name)}</div><div class="v">${rows.filter((r) => r.category === c.code).length}</div></div>`).join("")}
      </div>
      <div class="card list">
        <div class="row" style="margin-bottom:4px"><h3 class="grow" style="margin:0">Unit keluar</h3><button class="btn sm" data-act="rental-reload">↻</button></div>
        ${rows.map((r) => { const over = r.due_at && new Date(r.due_at).getTime() < now; return `<div class="li">
          <div style="font-size:24px">${h(catOf(r.category).icon)}</div>
          <div class="grow"><div class="b">${h(r.name)} ${r.item_ref ? `· <span style="color:var(--pri)">${h(r.item_ref)}</span>` : ""}</div>
            <div class="small muted">${h(r.tx.customer_name || "Tamu")}${r.tx.customer_note ? " · " + h(r.tx.customer_note) : ""} · ${h(r.tx.receipt_no)}</div>
            <div class="small">Keluar ${fmtDT(r.start_at)} → kembali <b>${r.due_at ? fmtDT(r.due_at) : "-"}</b> ${over ? `<span class="badge bad">Terlambat</span>` : ""}</div></div>
          <button class="btn pri sm" data-act="return" data-id="${r.id}">✓ Kembali</button>
        </div>`; }).join("") || `<div class="empty">Semua unit ada di tempat 👍</div>`}
      </div>`;
  }

  // ───────────────────────── render: shift ─────────────────────────
  async function loadShifts() {
    let q = sb.from("shifts").select("*, cashier:profiles(full_name)").order("opened_at", { ascending: false }).limit(20);
    if (!isAdmin()) q = q.eq("cashier_id", S.profile.id);
    S.shifts = must(await q);
  }
  function viewShift() {
    if (S.shifts === null) loadShifts().then(render).catch(() => {});
    const s = S.shift;
    const body = !s ? `
      <div class="card col" style="max-width:460px">
        <h3>Buka shift</h3>
        <label class="f">Modal kas awal<input class="inp" id="open-cash" inputmode="numeric" placeholder="0"></label>
        <button class="btn pri lg" data-act="shift-open">Buka shift</button>
      </div>` : `
      <div class="grid2">
        <div class="card col">
          <h3>Shift berjalan</h3>
          <div class="row"><span class="grow muted">Dibuka</span><b>${fmtDT(s.shift.opened_at)}</b></div>
          <div class="row"><span class="grow muted">Modal awal</span><b>${rp(s.shift.opening_cash)}</b></div>
          <div class="row"><span class="grow muted">Transaksi</span><b>${s.count}${s.void_count ? ` <span class="badge bad">${s.void_count} void</span>` : ""}</b></div>
          ${Object.entries(s.by_method || {}).map(([m, v]) => `<div class="row"><span class="grow muted">${h(m)}</span><b>${rp(v)}</b></div>`).join("")}
          <div class="row"><span class="grow b">Total penjualan</span><b style="font-size:20px;color:var(--pri)">${rp(s.total)}</b></div>
          <div class="row"><span class="grow muted">Kas seharusnya di laci</span><b>${rp(Number(s.shift.opening_cash) + Number(s.cash_sales))}</b></div>
        </div>
        <div class="card col">
          <h3>Tutup shift</h3>
          <label class="f">Uang tunai dihitung<input class="inp" id="close-cash" inputmode="numeric" placeholder="0"></label>
          <label class="f">Catatan<input class="inp" id="close-note" placeholder="opsional"></label>
          <button class="btn pri lg" data-act="shift-close">Tutup shift & cetak rekap</button>
        </div>
      </div>`;
    return body + `
      <div class="card" style="margin-top:14px"><h3>Riwayat shift</h3>
        ${S.shifts ? `<table class="t"><thead><tr><th>Kasir</th><th>Buka</th><th>Tutup</th><th class="n">Seharusnya</th><th class="n">Dihitung</th><th class="n">Selisih</th></tr></thead><tbody>
        ${S.shifts.map((x) => { const d = x.closed_at ? Number(x.closing_cash) - Number(x.expected_cash) : null; return `<tr>
          <td>${h(x.cashier?.full_name || "")}</td><td>${fmtDT(x.opened_at)}</td><td>${x.closed_at ? fmtDT(x.closed_at) : `<span class="badge">buka</span>`}</td>
          <td class="n">${x.closed_at ? rp(x.expected_cash) : "-"}</td><td class="n">${x.closed_at ? rp(x.closing_cash) : "-"}</td>
          <td class="n" style="color:${d < 0 ? "var(--bad)" : d > 0 ? "var(--warn)" : "inherit"}">${d === null ? "-" : (d > 0 ? "+" : "") + rp(d)}</td></tr>`; }).join("")}</tbody></table>` : `<div class="muted">Memuat…</div>`}
      </div>`;
  }
  function shiftLines(sum) {
    const w = P.getCfg().width, st = S.settings, s = sum.shift;
    const lr = (l, r) => { l = String(l); r = String(r); return l + " ".repeat(Math.max(1, w - l.length - r.length)) + r; };
    const n = (v) => Math.round(Number(v) || 0).toLocaleString("id-ID");
    const L = [{ t: st.business_name, align: "center", bold: true, big: true }, { t: "REKAP SHIFT", align: "center", bold: true }, { t: "=".repeat(w) },
      { t: lr("Kasir", S.profile.full_name) }, { t: lr("Buka", fmtDT(s.opened_at)) }, { t: lr("Tutup", s.closed_at ? fmtDT(s.closed_at) : "-") }, { t: "-".repeat(w) },
      { t: lr("Transaksi", sum.count) }, { t: lr("Void", sum.void_count) },
      ...Object.entries(sum.by_method || {}).map(([m, v]) => ({ t: lr(m, n(v)) })),
      { t: lr("TOTAL", n(sum.total)), bold: true }, { t: "-".repeat(w) },
      { t: lr("Modal awal", n(s.opening_cash)) }, { t: lr("Kas seharusnya", n(s.expected_cash ?? Number(s.opening_cash) + Number(sum.cash_sales))) },
      { t: lr("Kas dihitung", n(s.closing_cash)) }, { t: lr("Selisih", n(Number(s.closing_cash) - Number(s.expected_cash))), bold: true },
      ...(s.note ? [{ t: "Catatan: " + s.note }] : []), { t: "" }];
    return L.map((l) => Object.assign({ align: "left", bold: false, big: false }, l, { t: String(l.t ?? "").normalize("NFD").replace(/[^\x20-\x7E]/g, "") }));
  }

  // ───────────────────────── render: backoffice ─────────────────────────
  function viewBO() {
    if (!isAdmin()) return `<div class="empty">Khusus owner/admin.</div>`;
    const tabs = [["dash", "Dashboard"], ["report", "Laporan"], ["services", "Layanan & Harga"], ["users", "Pengguna"], ["store", "Pengaturan Toko"]];
    const body = { dash: boDash, report: boReport, services: boServices, users: boUsers, store: boStore }[S.bo.tab]();
    return `<div class="tabs">${tabs.map(([k, l]) => `<a class="${S.bo.tab === k ? "on" : ""}" data-act="bo-tab" data-t="${k}">${l}</a>`).join("")}</div>${body}`;
  }
  function bars(rows, labelFn, valFn, colorFn) {
    const max = Math.max(1, ...rows.map(valFn));
    return rows.map((r) => `<div style="margin:8px 0"><div class="row small"><span class="grow">${labelFn(r)}</span><b>${rp(valFn(r))}</b></div>
      <div class="bar" style="--c:${colorFn ? colorFn(r) : "var(--pri)"}"><i style="width:${(valFn(r) / max * 100).toFixed(1)}%"></i></div></div>`).join("") || `<div class="muted small">Belum ada data.</div>`;
  }
  function boDash() {
    if (!S.bo.dash) {
      Promise.all([
        sb.rpc("sales_report", { p_from: today(), p_to: today() }),
        sb.rpc("sales_report", { p_from: monthStart(), p_to: today() }),
        sb.rpc("sales_report", { p_from: addDays(today(), -13), p_to: today() }),
      ]).then(([a, b, c]) => { S.bo.dash = { today: must(a), month: must(b), d14: must(c) }; render(); }).catch((e) => toast(errMsg(e), true));
      return `<div class="empty">Memuat dashboard…</div>`;
    }
    const { today: td, month: mo, d14 } = S.bo.dash;
    const days = []; for (let i = 13; i >= 0; i--) { const d = addDays(today(), -i); const f = d14.by_day.find((x) => x.day === d); days.push({ day: d, total: f ? Number(f.total) : 0 }); }
    const max = Math.max(1, ...days.map((d) => d.total));
    return `
      <div class="kpis">
        <div class="kpi"><div class="muted small">Penjualan hari ini</div><div class="v">${rp(td.total)}</div><div class="small muted">${td.count} transaksi</div></div>
        <div class="kpi"><div class="muted small">Bulan ini</div><div class="v">${rp(mo.total)}</div><div class="small muted">${mo.count} transaksi</div></div>
        <div class="kpi"><div class="muted small">Rata-rata / transaksi (bulan)</div><div class="v">${rp(mo.count ? mo.total / mo.count : 0)}</div></div>
        <div class="kpi"><div class="muted small">Diskon bulan ini</div><div class="v">${rp(mo.discount)}</div><div class="small muted">${mo.void_count} void</div></div>
      </div>
      <div class="card" style="margin-top:14px"><div class="row"><h3 class="grow">14 hari terakhir</h3><button class="btn sm" data-act="dash-reload">↻</button></div>
        <div style="display:flex;align-items:flex-end;gap:6px;height:160px;padding-top:10px">
          ${days.map((d) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end" title="${fmtD(d.day)}: ${rp(d.total)}">
            <div style="width:100%;max-width:34px;background:${d.day === today() ? "var(--pri)" : "var(--pri-2)"};opacity:${d.day === today() ? 1 : .55};border-radius:6px 6px 2px 2px;height:${Math.max(2, d.total / max * 120)}px"></div>
            <div class="small muted" style="font-size:10px">${new Date(d.day + "T00:00:00").getDate()}</div></div>`).join("")}
        </div></div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>Per layanan — bulan ini</h3>${bars(mo.by_category, (r) => `${h(catOf(r.category).icon)} ${h(catOf(r.category).name)} <span class="muted">(${Number(r.qty).toLocaleString("id-ID")})</span>`, (r) => Number(r.total), (r) => catOf(r.category).color)}</div>
        <div class="card"><h3>Hari ini per metode bayar</h3>${bars(td.by_method, (r) => `${h(r.method)} <span class="muted">(${r.count})</span>`, (r) => Number(r.total))}</div>
      </div>`;
  }
  function boReport() {
    const R = S.bo.report;
    const presets = [["Hari ini", today(), today()], ["Kemarin", addDays(today(), -1), addDays(today(), -1)], ["7 hari", addDays(today(), -6), today()], ["Bulan ini", monthStart(), today()],
      ["Bulan lalu", (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; })(), addDays(monthStart(), -1)]];
    if (!R) { loadReport(); }
    return `
      <div class="card" style="margin-bottom:14px">
        <div class="chips" style="margin-bottom:10px">${presets.map(([l, a, b]) => `<button class="chip ${S.bo.from === a && S.bo.to === b ? "on" : ""}" data-act="rep-preset" data-a="${a}" data-b="${b}">${l}</button>`).join("")}</div>
        <div class="row wrap">
          <label class="f">Dari<input class="inp" type="date" value="${S.bo.from}" data-bind="rep-from"></label>
          <label class="f">Sampai<input class="inp" type="date" value="${S.bo.to}" data-bind="rep-to"></label>
          <span class="grow"></span>
          <button class="btn" data-act="rep-print" style="align-self:flex-end">🖨 Cetak ringkasan</button>
          <button class="btn pri" data-act="rep-csv" style="align-self:flex-end">⬇ Export CSV</button>
        </div>
      </div>
      ${!R ? `<div class="empty">Memuat laporan…</div>` : `
      <div class="kpis">
        <div class="kpi"><div class="muted small">Total penjualan</div><div class="v">${rp(R.total)}</div></div>
        <div class="kpi"><div class="muted small">Transaksi</div><div class="v">${R.count}</div><div class="small muted">${R.void_count} void</div></div>
        <div class="kpi"><div class="muted small">Penjualan kotor</div><div class="v">${rp(R.gross)}</div></div>
        <div class="kpi"><div class="muted small">Diskon</div><div class="v">${rp(R.discount)}</div>${Number(R.tax) ? `<div class="small muted">Pajak ${rp(R.tax)}</div>` : ""}</div>
      </div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>Per kategori</h3>${bars(R.by_category, (r) => `${h(catOf(r.category).icon)} ${h(catOf(r.category).name)}`, (r) => Number(r.total), (r) => catOf(r.category).color)}</div>
        <div class="card"><h3>Per metode bayar</h3>${bars(R.by_method, (r) => `${h(r.method)} <span class="muted">(${r.count})</span>`, (r) => Number(r.total))}</div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Per layanan</h3><table class="t"><thead><tr><th>Layanan</th><th class="n">Qty</th><th class="n">Total</th></tr></thead><tbody>
        ${R.by_service.map((r) => `<tr><td>${h(catOf(r.category).icon)} ${h(r.name)}</td><td class="n">${Number(r.qty).toLocaleString("id-ID")}</td><td class="n">${rp(r.total)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Belum ada data</td></tr>`}</tbody></table></div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>Per kasir</h3><table class="t"><tbody>${R.by_cashier.map((r) => `<tr><td>${h(r.cashier)}</td><td class="n">${r.count} trx</td><td class="n">${rp(r.total)}</td></tr>`).join("") || `<tr><td class="muted">-</td></tr>`}</tbody></table></div>
        <div class="card"><h3>Per hari</h3><table class="t"><tbody>${R.by_day.map((r) => `<tr><td>${fmtD(r.day)}</td><td class="n">${r.count} trx</td><td class="n">${rp(r.total)}</td></tr>`).join("") || `<tr><td class="muted">-</td></tr>`}</tbody></table></div>
      </div>`}`;
  }
  let repLoading = false;
  async function loadReport() {
    if (repLoading) return; repLoading = true;
    try { S.bo.report = must(await sb.rpc("sales_report", { p_from: S.bo.from, p_to: S.bo.to })); render(); }
    catch (e) { toast(errMsg(e), true); } finally { repLoading = false; }
  }
  async function exportCsv() {
    const rows = await run(async () => must(await sb.from("transactions").select("*, cashier:profiles!transactions_cashier_id_fkey(full_name), items:transaction_items(*)")
      .gte("created_at", dayStartISO(S.bo.from)).lt("created_at", dayEndISO(S.bo.to)).order("created_at").limit(10000)));
    if (!rows) return;
    const q = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["No Struk", "Tanggal", "Jam", "Status", "Kasir", "Tamu", "HP", "Catatan", "Kategori", "Layanan", "Ref", "Qty", "Satuan", "Harga", "Jumlah", "Subtotal Struk", "Diskon Struk", "Pajak Struk", "Total Struk", "Metode Bayar"];
    const out = [head.join(",")];
    for (const t of rows) for (const [i, it] of t.items.entries()) {
      const d = new Date(t.created_at);
      out.push([t.receipt_no, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, fmtT(t.created_at), t.status, t.cashier?.full_name, t.customer_name, t.customer_phone, t.customer_note,
        catOf(it.category).name, it.name, it.item_ref, it.qty, UNIT[it.unit] || it.unit, it.price, it.line_total,
        i === 0 ? t.subtotal : "", i === 0 ? t.discount : "", i === 0 ? t.tax : "", i === 0 ? t.total : "", t.payment_method].map(q).join(","));
    }
    const blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const name = `PX-POS_${S.bo.from}_${S.bo.to}.csv`;
    if (P.isNative() && navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: "text/csv" })] })) {
      try { await navigator.share({ files: [new File([blob], name, { type: "text/csv" })], title: name }); return; } catch {}
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    toast("CSV diunduh");
  }
  function reportLines() {
    const R = S.bo.report, w = P.getCfg().width;
    const lr = (l, r) => { l = String(l).slice(0, w - String(r).length - 1); r = String(r); return l + " ".repeat(Math.max(1, w - l.length - r.length)) + r; };
    const n = (v) => Math.round(Number(v) || 0).toLocaleString("id-ID");
    const L = [[S.settings.business_name, "center", true, true], ["LAPORAN PENJUALAN", "center", true], [`${S.bo.from} s/d ${S.bo.to}`, "center"], ["=".repeat(w)],
      [lr("Transaksi", R.count)], [lr("Void", R.void_count)], [lr("Kotor", n(R.gross))], [lr("Diskon", n(R.discount))], ...(Number(R.tax) ? [[lr("Pajak", n(R.tax))]] : []),
      [lr("TOTAL", n(R.total)), "left", true], ["-".repeat(w)], ["Per layanan:", "left", true],
      ...R.by_service.map((r) => [lr(`${r.name} x${Number(r.qty).toLocaleString("id-ID")}`, n(r.total))]), ["-".repeat(w)], ["Per metode:", "left", true],
      ...R.by_method.map((r) => [lr(r.method, n(r.total))]), ["-".repeat(w)], [`Dicetak ${fmtDT(new Date())}`, "center"], [""]];
    return L.map(([t, align = "left", bold = false, big = false]) => ({ t: String(t ?? "").normalize("NFD").replace(/[^\x20-\x7E]/g, ""), align, bold, big }));
  }

  function boServices() {
    const UNITS = Object.keys(UNIT);
    return `
      <div class="row wrap" style="margin-bottom:12px"><span class="grow muted small">Tap layanan untuk ubah harga/nama. Perubahan langsung dipakai di kasir.</span>
        <button class="btn" data-act="cat-edit" data-c="">+ Kategori</button><button class="btn pri" data-act="svc-edit" data-id="">+ Layanan</button></div>
      ${S.cats.map((c) => `<div class="card" style="margin-bottom:12px;${c.active ? "" : "opacity:.6"}">
        <div class="row"><span style="font-size:24px">${h(c.icon)}</span><h3 class="grow" style="margin:0">${h(c.name)} ${c.is_rental ? `<span class="badge">rental</span>` : ""} ${c.active ? "" : `<span class="badge gray">nonaktif</span>`}</h3>
          <button class="btn sm" data-act="cat-edit" data-c="${h(c.code)}">Ubah</button></div>
        <div class="list">${S.services.filter((s) => s.category === c.code).map((s) => `<div class="li" data-act="svc-edit" data-id="${s.id}" style="cursor:pointer">
          <div class="grow"><div class="b">${h(s.name)} ${s.active ? "" : `<span class="badge gray">nonaktif</span>`}</div><div class="small muted">${h(s.description || "")}${s.duration_hours ? ` · ${Number(s.duration_hours)} jam` : ""}</div></div>
          <div class="b">${rp(s.price)} <span class="small muted">/ ${UNIT[s.unit] || s.unit}</span></div></div>`).join("") || `<div class="muted small" style="padding:8px 0">Belum ada layanan.</div>`}</div>
      </div>`).join("")}
      <datalist id="units">${UNITS.map((u) => `<option value="${u}">`).join("")}</datalist>`;
  }
  function svcForm(id) {
    const s = S.services.find((x) => x.id === id) || { category: S.cats[0]?.code, name: "", price: 0, unit: "session", description: "", duration_hours: null, active: true, sort: 0 };
    modal(`<h2>${id ? "Ubah layanan" : "Layanan baru"}</h2><form class="col" data-form="svc" data-id="${id || ""}">
      <label class="f">Kategori<select class="inp" name="category">${S.cats.map((c) => `<option value="${h(c.code)}" ${c.code === s.category ? "selected" : ""}>${h(c.icon)} ${h(c.name)}</option>`).join("")}</select></label>
      <label class="f">Nama layanan<input class="inp" name="name" value="${h(s.name)}" required autofocus></label>
      <div class="grid2" style="gap:10px">
        <label class="f">Harga (Rp)<input class="inp" name="price" inputmode="numeric" value="${Number(s.price)}" required></label>
        <label class="f">Satuan<select class="inp" name="unit">${Object.entries(UNIT).map(([k, v]) => `<option value="${k}" ${k === s.unit ? "selected" : ""}>per ${v}</option>`).join("")}</select></label>
      </div>
      <div class="grid2" style="gap:10px">
        <label class="f">Durasi tetap (jam, opsional)<input class="inp" name="duration_hours" inputmode="decimal" value="${s.duration_hours ?? ""}"></label>
        <label class="f">Urutan<input class="inp" name="sort" inputmode="numeric" value="${s.sort}"></label>
      </div>
      <label class="f">Keterangan<input class="inp" name="description" value="${h(s.description)}"></label>
      <label class="row"><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Aktif (tampil di kasir)</label>
      <div class="mfoot">${id ? `<button type="button" class="btn bad" data-act="svc-del" data-id="${id}">Hapus</button><span class="grow"></span>` : ""}
        <button type="button" class="btn" data-act="m-close">Batal</button><button class="btn pri" type="submit">Simpan</button></div></form>`);
  }
  function catForm(code) {
    const c = S.cats.find((x) => x.code === code) || { code: "", name: "", icon: "🛎️", color: "#0f766e", is_rental: false, sort: S.cats.length + 1, active: true };
    modal(`<h2>${code ? "Ubah kategori" : "Kategori baru"}</h2><form class="col" data-form="cat" data-c="${h(code || "")}">
      <div class="grid2" style="gap:10px">
        <label class="f">Nama<input class="inp" name="name" value="${h(c.name)}" required autofocus></label>
        <label class="f">Kode (huruf kecil)<input class="inp" name="code" value="${h(c.code)}" ${code ? "readonly" : ""} pattern="[a-z0-9_]{2,30}" required></label>
      </div>
      <div class="grid3">
        <label class="f">Ikon (emoji)<input class="inp" name="icon" value="${h(c.icon)}"></label>
        <label class="f">Warna<input class="inp" type="color" name="color" value="${h(c.color)}" style="padding:4px"></label>
        <label class="f">Urutan<input class="inp" name="sort" inputmode="numeric" value="${c.sort}"></label>
      </div>
      <label class="row"><input type="checkbox" name="is_rental" ${c.is_rental ? "checked" : ""}> Rental (unit keluar & harus kembali — muncul di menu Rental)</label>
      <label class="row"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Aktif</label>
      <div class="mfoot"><button type="button" class="btn" data-act="m-close">Batal</button><button class="btn pri" type="submit">Simpan</button></div></form>`);
  }

  function boUsers() {
    if (!S.bo.users) { sb.from("profiles").select("*").order("created_at").then((r) => { S.bo.users = must(r); render(); }).catch((e) => toast(errMsg(e), true)); return `<div class="empty">Memuat pengguna…</div>`; }
    const roleBadge = (r) => `<span class="badge ${r === "cashier" ? "gray" : ""}">${r === "cashier" ? "kasir" : r}</span>`;
    return `<div class="row" style="margin-bottom:12px"><span class="grow muted small">Kasir login pakai <b>username</b> + password yang kamu buat di sini.</span><button class="btn pri" data-act="user-new">+ Pengguna</button></div>
      <div class="card list">${S.bo.users.map((u) => `<div class="li">
        <div class="logo-mark" style="width:38px;height:38px;font-size:14px;border-radius:12px;${u.active ? "" : "filter:grayscale(1);opacity:.6"}">${h((u.full_name || "?").slice(0, 2).toUpperCase())}</div>
        <div class="grow"><div class="b">${h(u.full_name)} ${roleBadge(u.role)} ${u.active ? "" : `<span class="badge warn">nonaktif</span>`}</div><div class="small muted">${h(u.username || "")}</div></div>
        ${u.id !== S.profile.id ? `<button class="btn sm" data-act="user-edit" data-id="${u.id}">Ubah</button>` : `<span class="small muted">kamu</span>`}
      </div>`).join("")}</div>`;
  }
  function userForm(id) {
    const u = id ? S.bo.users.find((x) => x.id === id) : null;
    const owner = S.profile.role === "owner";
    const roles = [["cashier", "Kasir"], ...(owner || u?.role === "admin" ? [["admin", "Admin (backoffice)"]] : []), ...(owner ? [["owner", "Owner"]] : [])];
    modal(`<h2>${u ? "Ubah pengguna" : "Pengguna baru"}</h2><form class="col" data-form="user" data-id="${id || ""}">
      <label class="f">Nama lengkap<input class="inp" name="full_name" value="${h(u?.full_name || "")}" required autofocus></label>
      ${u ? `<div class="small muted">Username: <b>${h(u.username || "-")}</b></div>` : `<label class="f">Username (untuk login)<input class="inp" name="username" autocapitalize="none" pattern="[a-z0-9._\\-]{3,30}" placeholder="mis. kasir1" required></label>
      <label class="f">Password<input class="inp" name="password" type="text" minlength="6" required></label>`}
      <label class="f">Role<select class="inp" name="role">${roles.map(([k, l]) => `<option value="${k}" ${u?.role === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${u ? `<label class="row"><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Aktif (bisa login & transaksi)</label>` : ""}
      <div class="mfoot">${u ? `<button type="button" class="btn bad" data-act="user-del" data-id="${id}">Hapus</button><button type="button" class="btn" data-act="user-pw" data-id="${id}">Reset password</button><span class="grow"></span>` : ""}
        <button type="button" class="btn" data-act="m-close">Batal</button><button class="btn pri" type="submit">Simpan</button></div></form>`);
  }
  async function adminFn(body) {
    const { data, error } = await sb.functions.invoke("admin-users", { body });
    if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch {} throw new Error(m); }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  function boStore() {
    const s = S.settings;
    return `<form class="card col" data-form="store" style="max-width:640px">
      <h3>Info usaha (tampil di struk)</h3>
      <label class="f">Nama usaha<input class="inp" name="business_name" value="${h(s.business_name)}" required></label>
      <label class="f">Alamat<input class="inp" name="address" value="${h(s.address)}"></label>
      <label class="f">Telepon / WA<input class="inp" name="phone" value="${h(s.phone)}"></label>
      <label class="f">Teks atas struk (opsional)<textarea class="inp" name="receipt_header" rows="2">${h(s.receipt_header)}</textarea></label>
      <label class="f">Teks bawah struk<textarea class="inp" name="receipt_footer" rows="2">${h(s.receipt_footer)}</textarea></label>
      <div class="grid3">
        <label class="f">Prefix no. struk<input class="inp" name="receipt_prefix" value="${h(s.receipt_prefix)}" maxlength="6"></label>
        <label class="f">Pajak / service (%)<input class="inp" name="tax_percent" inputmode="decimal" value="${Number(s.tax_percent)}"></label>
        <label class="f">Maks. diskon kasir (%)<input class="inp" name="max_discount_pct" inputmode="decimal" value="${Number(s.max_discount_pct)}"></label>
      </div>
      <label class="f">Metode bayar (pisahkan koma)<input class="inp" name="payment_methods" value="${h(s.payment_methods.join(", "))}"></label>
      <div class="small muted">"Cash" dipakai untuk hitung kembalian & rekap kas shift.</div>
      <div class="mfoot"><button class="btn pri" type="submit">Simpan pengaturan</button></div>
    </form>`;
  }

  // ───────────────────────── render: settings (printer & account) ─────────────────────────
  function viewSettings() {
    const c = P.getCfg();
    const opts = [["auto", "Otomatis"], ...(P.hasNative() ? [["native", "Bluetooth (printer ter-pair)"]] : []), ...(P.hasWebBt() && !P.isNative() ? [["webbt", "Bluetooth BLE (browser)"]] : []),
      ...(P.isAndroid ? [["rawbt", "Aplikasi RawBT"]] : []), ["system", "Dialog print sistem / PDF"]];
    return `<div class="grid2">
      <div class="card col">
        <h3>🖨 Printer struk (perangkat ini)</h3>
        <label class="f">Cara cetak<select class="inp" data-bind="pr" data-f="method">${opts.map(([k, l]) => `<option value="${k}" ${c.method === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        ${P.hasNative() ? `<div class="row"><div class="grow"><div class="small muted">Printer terpilih</div><div class="b">${h(c.name || "Belum dipilih")}</div><div class="small muted">${h(c.address)}</div></div><button class="btn" data-act="pr-pick">Pilih printer</button></div>
          <div class="small muted">Pair printer dulu di Pengaturan Bluetooth Android (PIN biasanya 0000 / 1234).</div>` : ""}
        ${!P.isNative() && P.hasWebBt() ? `<div class="row"><div class="grow"><div class="small muted">Printer BLE</div><div class="b">${h(c.name || "Belum terhubung")}</div></div><button class="btn" data-act="pr-ble">Hubungkan</button></div>` : ""}
        ${P.isAndroid && !P.hasNative() ? `<div class="small muted">Untuk printer Bluetooth biasa di browser, install aplikasi <b>RawBT</b> dari Play Store, atau pakai APK PX POS.</div>` : ""}
        <div class="grid2" style="gap:10px">
          <label class="f">Lebar kertas<select class="inp" data-bind="pr" data-f="width"><option value="32" ${c.width == 32 ? "selected" : ""}>58 mm (32 kolom)</option><option value="48" ${c.width == 48 ? "selected" : ""}>80 mm (48 kolom)</option></select></label>
          <label class="f">Jumlah salinan<select class="inp" data-bind="pr" data-f="copies">${[1, 2, 3].map((n) => `<option ${c.copies == n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        </div>
        <label class="row"><input type="checkbox" data-bind="pr" data-f="autoPrint" ${c.autoPrint ? "checked" : ""}> Cetak otomatis setelah bayar</label>
        <label class="row"><input type="checkbox" data-bind="pr" data-f="cut" ${c.cut ? "checked" : ""}> Potong kertas otomatis (jika printer punya cutter)</label>
        <button class="btn pri" data-act="pr-test">Tes cetak</button>
      </div>
      <div class="card col">
        <h3>👤 Akun</h3>
        <div><div class="b">${h(S.profile.full_name)}</div><div class="small muted">${h(S.profile.username || S.session.user.email)} · ${h(S.profile.role)}</div></div>
        <button class="btn" data-act="my-pw">Ganti password</button>
        <button class="btn bad" data-act="logout">Keluar</button>
        <div class="small muted">PX POS v${h(C.version)}${P.isNative() ? " · Android" : " · Web"}</div>
      </div>
    </div>`;
  }

  // ───────────────────────── actions ─────────────────────────
  const cartLine = (k) => S.cart.find((l) => l.key === k);
  const ACT = {
    "modal-bg": (el, e) => { if (e.target === el) closeModal(); },
    "m-close": () => closeModal(),
    "auth-mode": (el, e) => { e.preventDefault(); S.authMode = el.dataset.m; render(); },
    logout: async () => { if (await ask("Keluar?", "Kamu akan keluar dari PX POS di perangkat ini.", "Keluar")) { await sb.auth.signOut(); } },
    recheck: () => run(async () => { await loadProfile(); if (S.profile?.active) await afterLogin(); render(); }),
    go: (el) => {
      S.view = el.dataset.v; S.cartOpen = false;
      if (S.view === "tx") S.tx.rows = null;
      if (S.view === "rental") S.rentals = null;
      if (S.view === "shift") { S.shifts = null; loadShift().then(render).catch(() => {}); }
      if (S.view === "bo") { S.bo.dash = null; S.bo.report = null; S.bo.users = null; }
      if (S.view === "pos") loadMaster().then(render).catch(() => {});
      render(); window.scrollTo(0, 0);
    },
    cat: (el) => { S.cat = el.dataset.c; render(); },
    add: (el) => { const s = S.services.find((x) => x.id === el.dataset.id); if (s) { addToCart(s); render(); } },
    qty: (el) => { const l = cartLine(el.dataset.k); if (!l) return; l.qty = Math.max(0, (Number(l.qty) || 0) + Number(el.dataset.d)); if (l.qty === 0) S.cart = S.cart.filter((x) => x !== l); render(); },
    del: (el) => { S.cart = S.cart.filter((x) => x.key !== el.dataset.k); render(); },
    dup: (el) => { const l = cartLine(el.dataset.k); if (l) { S.cart.splice(S.cart.indexOf(l) + 1, 0, Object.assign({}, l, { key: Math.random().toString(36).slice(2), item_ref: "" })); render(); } },
    price: async (el, e) => {
      e.preventDefault(); if (!isAdmin()) return toast("Harga hanya bisa diubah admin (Backoffice → Layanan & Harga)", true);
      const l = cartLine(el.dataset.k); const v = await prompt("Ubah harga untuk transaksi ini", { label: l.name, value: l.price, type: "number", hint: `Harga normal ${rp(l.base)}` });
      if (v !== null && v !== "") { l.price = Math.max(0, Math.round(num(v))); render(); }
    },
    "cart-clear": async () => { if (await ask("Kosongkan keranjang?", "Semua item akan dihapus.", "Kosongkan", true)) { resetSale(); render(); } },
    "cart-open": () => { S.cartOpen = true; render(); window.scrollTo(0, 0); },
    "cart-close": () => { S.cartOpen = false; render(); },
    "disc-mode": (el) => { S.disc.mode = el.dataset.m; rerenderCart(); },
    method: (el) => { S.pay.method = el.dataset.m; S.pay.paid = ""; rerenderCart(); },
    paid: (el) => { S.pay.paid = String(Number(el.dataset.v)); rerenderCart(); },
    checkout: () => checkout(),
    print: (el) => { const t = S.lastTx && S.lastTx.id === el.dataset.id ? S.lastTx : null; if (t) printTx(t, t.status === "void" ? "SALINAN - VOID" : undefined); },
    wa: (el) => { const t = S.lastTx; if (t && t.id === el.dataset.id) waTx(t); },
    void: async (el) => {
      const reason = await prompt("Void transaksi", { label: "Alasan void (wajib)", placeholder: "mis. salah input", okLabel: "Void" });
      if (!reason) return;
      const ok = await run(async () => { must(await sb.rpc("void_sale", { p_id: el.dataset.id, p_reason: reason })); return true; }, "Transaksi di-void");
      if (ok) { S.tx.rows = null; render(); const t = await run(() => fetchTx(el.dataset.id)); if (t) showReceipt(t); }
    },
    "tx-open": async (el) => { const t = await run(() => fetchTx(el.dataset.id)); if (t) showReceipt(t); },
    "tx-reload": () => { S.tx.rows = null; render(); },
    "rental-reload": () => { S.rentals = null; render(); },
    return: async (el) => {
      const r = S.rentals.find((x) => x.id === el.dataset.id);
      if (!(await ask("Unit sudah kembali?", `${h(r.name)} ${r.item_ref ? "· " + h(r.item_ref) : ""} — ${h(r.tx.customer_name || "Tamu")}`, "Ya, sudah kembali"))) return;
      const ok = await run(async () => { must(await sb.rpc("return_rental", { p_item: r.id })); return true; }, "Ditandai sudah kembali");
      if (ok) { S.rentals = null; render(); }
    },
    "shift-open": async () => {
      const cash = num($("#open-cash").value);
      const ok = await run(async () => { must(await sb.rpc("open_shift", { p_cash: cash })); await loadShift(); return true; }, "Shift dibuka");
      if (ok) { S.shifts = null; render(); }
    },
    "shift-close": async () => {
      const cash = num($("#close-cash").value), note = $("#close-note").value;
      if (!(await ask("Tutup shift?", `Uang tunai dihitung: <b>${rp(cash)}</b>`, "Tutup shift"))) return;
      const sum = await run(async () => must(await sb.rpc("close_shift", { p_cash: cash, p_note: note })), "Shift ditutup");
      if (!sum) return;
      S.shift = null; S.shifts = null; render();
      const lines = shiftLines(sum);
      const diff = Number(sum.shift.closing_cash) - Number(sum.shift.expected_cash);
      modal(`<h2>Rekap shift</h2><div class="center" style="margin-bottom:10px">Selisih kas: <b style="color:${diff < 0 ? "var(--bad)" : "var(--ok)"}">${(diff > 0 ? "+" : "") + rp(diff)}</b></div>${P.toHtml(lines)}
        <div class="mfoot"><button class="btn" data-act="print-lines">🖨 Cetak</button><button class="btn pri" data-act="m-close">Selesai</button></div>`);
      S.printLines = lines;
    },
    "print-lines": () => run(() => P.print(S.printLines)),
    "bo-tab": (el) => { S.bo.tab = el.dataset.t; if (S.bo.tab === "report") S.bo.report = null; if (S.bo.tab === "dash") S.bo.dash = null; if (S.bo.tab === "users") S.bo.users = null; render(); },
    "dash-reload": () => { S.bo.dash = null; render(); },
    "rep-preset": (el) => { S.bo.from = el.dataset.a; S.bo.to = el.dataset.b; S.bo.report = null; render(); },
    "rep-csv": () => exportCsv(),
    "rep-print": () => { if (S.bo.report) run(() => P.print(reportLines())); },
    "svc-edit": (el) => svcForm(el.dataset.id),
    "cat-edit": (el) => catForm(el.dataset.c),
    "svc-del": async (el) => {
      if (!(await ask("Hapus layanan?", "Riwayat transaksi tetap aman. Kalau hanya ingin menyembunyikan, matikan centang Aktif.", "Hapus", true))) return;
      const ok = await run(async () => { must(await sb.from("services").delete().eq("id", el.dataset.id)); await loadMaster(); return true; }, "Layanan dihapus");
      if (ok) render();
    },
    "user-new": () => userForm(null),
    "user-edit": (el) => userForm(el.dataset.id),
    "user-pw": async (el) => {
      const pw = await prompt("Reset password", { label: "Password baru (min. 6 karakter)", okLabel: "Reset" });
      if (pw) await run(() => adminFn({ action: "set_password", user_id: el.dataset.id, password: pw }), "Password diganti");
    },
    "user-del": async (el) => {
      if (!(await ask("Hapus pengguna?", "Kalau pengguna sudah punya transaksi, akunnya hanya dinonaktifkan supaya riwayat tetap utuh.", "Hapus", true))) return;
      const r = await run(() => adminFn({ action: "delete", user_id: el.dataset.id }));
      if (r) { toast(r.deactivated ? "Pengguna dinonaktifkan" : "Pengguna dihapus"); closeModal(); S.bo.users = null; render(); }
    },
    "pr-pick": async () => {
      const devs = await run(() => P.listPaired()); if (!devs) return;
      modal(`<h2>Pilih printer</h2><div class="list">${devs.map((d) => `<div class="li" data-act="pr-set" data-a="${h(d.address)}" data-n="${h(d.name || d.address)}" style="cursor:pointer"><span style="font-size:22px">🖨</span><div class="grow"><div class="b">${h(d.name || "(tanpa nama)")}</div><div class="small muted">${h(d.address)}</div></div></div>`).join("") || `<div class="empty">Belum ada perangkat ter-pair. Pair printer di Pengaturan Bluetooth Android dulu.</div>`}</div><div class="mfoot"><button class="btn" data-act="m-close">Tutup</button></div>`);
    },
    "pr-set": (el) => { P.setCfg({ address: el.dataset.a, name: el.dataset.n, method: "native" }); closeModal(); render(); toast("Printer dipilih: " + el.dataset.n); },
    "pr-ble": () => run(async () => { await P.webConnect(true); P.setCfg({ method: "webbt" }); render(); }, "Printer terhubung"),
    "pr-test": () => run(() => P.print(P.testLines(S.settings))),
    "my-pw": async () => {
      const pw = await prompt("Ganti password", { label: "Password baru (min. 6 karakter)", type: "password" });
      if (pw) await run(async () => { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; }, "Password diganti");
    },
  };

  const BIND = {
    qty: (el) => { const l = cartLine(el.dataset.k); if (l) { l.qty = el.value === "" ? "" : num(el.value); refreshTotals(); const amt = el.closest(".ci").querySelector(".t > .b"); if (amt) amt.textContent = rp(Math.round(l.price * (Number(l.qty) || 0))); } },
    ref: (el) => { const l = cartLine(el.dataset.k); if (l) l.item_ref = el.value; },
    cust: (el) => { S.cust[el.dataset.f] = el.value; },
    disc: (el) => { S.disc.v = el.value; refreshTotals(); },
    paid: (el) => { S.pay.paid = el.value.replace(/[^\d]/g, ""); refreshTotals(); },
    "tx-q": (el) => { S.tx.q = el.value; clearTimeout(BIND._t); BIND._t = setTimeout(() => { render(); const i = $('[data-bind="tx-q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); },
  };
  const CHANGE = {
    "tx-from": (el) => { S.tx.from = el.value || today(); S.tx.rows = null; render(); },
    "tx-to": (el) => { S.tx.to = el.value || today(); S.tx.rows = null; render(); },
    "rep-from": (el) => { S.bo.from = el.value; S.bo.report = null; render(); },
    "rep-to": (el) => { S.bo.to = el.value; S.bo.report = null; render(); },
    qty: () => render(),
    pr: (el) => { const f = el.dataset.f; P.setCfg({ [f]: el.type === "checkbox" ? el.checked : (f === "width" || f === "copies" ? Number(el.value) : el.value) }); render(); },
  };

  const FORMS = {
    login: async (fd) => {
      let user = String(fd.get("user")).trim().toLowerCase();
      if (!user.includes("@")) user = `${user}@${C.usernameDomain}`;
      await run(async () => { const { error } = await sb.auth.signInWithPassword({ email: user, password: fd.get("password") }); if (error) throw new Error(error.message === "Invalid login credentials" ? "Username/email atau password salah" : error.message); });
    },
    register: async (fd) => {
      const user = String(fd.get("user")).trim().toLowerCase(); const username = null;
      if (!user.includes("@")) return toast("Daftar pakai email asli (link konfirmasi dikirim ke email). Akun kasir dibuat admin dengan username.", true);
      await run(async () => {
        const { data, error } = await sb.auth.signUp({ email: user, password: fd.get("password"), options: { data: { full_name: fd.get("full_name"), username }, emailRedirectTo: C.webUrl } });
        if (error) throw error;
        if (!data.session) { S.authMode = "login"; render(); modal(`<h2>Cek email kamu 📧</h2><div class="muted">Link konfirmasi dikirim ke <b>${h(user)}</b>. Klik link-nya, lalu kembali ke sini dan masuk dengan email + password tadi.</div><div class="mfoot"><button class="btn pri" data-act="m-close">OK</button></div>`); }
      });
    },
    svc: async (fd, form) => {
      const id = form.dataset.id;
      const row = { category: fd.get("category"), name: String(fd.get("name")).trim(), price: Math.round(num(fd.get("price"))), unit: fd.get("unit"),
        duration_hours: fd.get("duration_hours") ? num(fd.get("duration_hours")) : null, sort: Math.round(num(fd.get("sort"))), description: String(fd.get("description")).trim(), active: fd.get("active") === "on" };
      const ok = await run(async () => { must(id ? await sb.from("services").update(row).eq("id", id) : await sb.from("services").insert(row)); await loadMaster(); return true; }, "Layanan disimpan");
      if (ok) { closeModal(); render(); }
    },
    cat: async (fd, form) => {
      const code = form.dataset.c;
      const row = { name: String(fd.get("name")).trim(), icon: fd.get("icon") || "🛎️", color: fd.get("color"), sort: Math.round(num(fd.get("sort"))), is_rental: fd.get("is_rental") === "on", active: fd.get("active") === "on" };
      const ok = await run(async () => { must(code ? await sb.from("categories").update(row).eq("code", code) : await sb.from("categories").insert(Object.assign(row, { code: String(fd.get("code")).trim() }))); await loadMaster(); return true; }, "Kategori disimpan");
      if (ok) { closeModal(); render(); }
    },
    user: async (fd, form) => {
      const id = form.dataset.id;
      const ok = await run(async () => {
        if (id) must(await sb.from("profiles").update({ full_name: String(fd.get("full_name")).trim(), role: fd.get("role"), active: fd.get("active") === "on" }).eq("id", id));
        else await adminFn({ action: "create", full_name: String(fd.get("full_name")).trim(), username: String(fd.get("username")).trim().toLowerCase(), password: fd.get("password"), role: fd.get("role") });
        return true;
      }, "Pengguna disimpan");
      if (ok) { closeModal(); S.bo.users = null; render(); }
    },
    store: async (fd) => {
      const row = { business_name: String(fd.get("business_name")).trim(), address: String(fd.get("address")).trim(), phone: String(fd.get("phone")).trim(),
        receipt_header: String(fd.get("receipt_header")), receipt_footer: String(fd.get("receipt_footer")), receipt_prefix: String(fd.get("receipt_prefix")).trim().toUpperCase() || "PX",
        tax_percent: num(fd.get("tax_percent")), max_discount_pct: num(fd.get("max_discount_pct")),
        payment_methods: String(fd.get("payment_methods")).split(",").map((s) => s.trim()).filter(Boolean) };
      if (!row.payment_methods.length) return toast("Minimal satu metode bayar", true);
      const ok = await run(async () => { must(await sb.from("settings").update(row).eq("id", 1)); await loadMaster(); return true; }, "Pengaturan disimpan");
      if (ok) render();
    },
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const f = ACT[el.dataset.act]; if (f) f(el, e);
  });
  document.addEventListener("input", (e) => { const el = e.target.closest("[data-bind]"); if (el && BIND[el.dataset.bind]) BIND[el.dataset.bind](el, e); });
  document.addEventListener("change", (e) => { const el = e.target.closest("[data-bind]"); if (el && CHANGE[el.dataset.bind]) CHANGE[el.dataset.bind](el, e); });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-form]"); if (!form) return;
    e.preventDefault(); const f = FORMS[form.dataset.form]; if (f) f(new FormData(form), form);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#modal-root").innerHTML) closeModal(); });
  // Android hardware back button (Capacitor)
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
    await loadShift().catch(() => { S.shift = null; });
  }
  async function onSession(session) {
    const prevUser = S.session && S.session.user.id;
    S.session = session;
    if (!session) { S.profile = null; S.settings = null; S.view = "pos"; render(); return; }
    if (prevUser === session.user.id && S.profile) return; // token refresh
    render();
    try {
      await loadProfile();
      if (S.profile && S.profile.active) await afterLogin();
    } catch (e) { toast(errMsg(e), true); }
    render();
  }
  if (C.supabaseUrl.startsWith("__")) {
    $("#app").innerHTML = `<div class="boot"><div class="logo-mark">PX</div><div>Supabase belum dikonfigurasi (js/config.js).</div></div>`;
    return;
  }
  sb.auth.onAuthStateChange((_ev, session) => { setTimeout(() => onSession(session), 0); });
  if ("serviceWorker" in navigator && !P.isNative() && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
