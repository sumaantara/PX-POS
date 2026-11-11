/* PX POS — receipt layout + printing (ESC/POS over Bluetooth, RawBT, or the system print dialog) */
(function () {
  "use strict";
  const LS_KEY = "pxpos.printer";
  const defaults = { method: "auto", address: "", name: "", width: 32, copies: 1, autoPrint: false, cut: true };
  const getCfg = () => { try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); } catch { return { ...defaults }; } };
  const setCfg = (c) => { try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(getCfg(), c))); } catch {} };

  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const nativePlugin = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BtPrinter;
  const isAndroid = /Android/i.test(navigator.userAgent);

  // ── text helpers ─────────────────────────────────────────
  const ascii = (s) => String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...")
    .replace(/[^\x20-\x7E\n]/g, "");
  const rupiah = (n) => "Rp" + Math.round(Number(n) || 0).toLocaleString("id-ID");
  const num = (n) => Math.round(Number(n) || 0).toLocaleString("id-ID");
  const wrap = (s, w) => {
    const out = []; let line = "";
    for (const word of ascii(s).split(/\s+/).filter(Boolean)) {
      if (word.length > w) { if (line) { out.push(line); line = ""; } for (let i = 0; i < word.length; i += w) out.push(word.slice(i, i + w)); continue; }
      if ((line ? line.length + 1 : 0) + word.length > w) { out.push(line); line = word; } else line = line ? line + " " + word : word;
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };
  const lr = (l, r, w) => { l = ascii(l); r = ascii(r); const sp = w - l.length - r.length; return sp >= 1 ? l + " ".repeat(sp) + r : (l.slice(0, Math.max(0, w - r.length - 1)) + " " + r); };
  const fmtDT = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${p(x.getDate())}/${p(x.getMonth() + 1)}/${x.getFullYear()} ${p(x.getHours())}:${p(x.getMinutes())}`; };
  const UNIT = { day: "hari", hour: "jam", session: "sesi", kg: "kg", pcs: "pcs", trip: "trip", person: "org" };

  // ── receipt model: list of {t, align, bold, big} ─────────
  function buildReceipt(tx, items, st, opts = {}) {
    const w = opts.width || getCfg().width || 32;
    const L = [];
    const add = (t, o = {}) => L.push(Object.assign({ t: ascii(t), align: "left", bold: false, big: false }, o));
    const hr = (c = "-") => add(c.repeat(w));
    add(st.business_name || "PX", { align: "center", bold: true, big: true });
    for (const s of [st.address, st.phone].filter(Boolean)) wrap(s, w).forEach((x) => add(x, { align: "center" }));
    if (st.receipt_header) String(st.receipt_header).split("\n").forEach((ln) => wrap(ln, w).forEach((x) => add(x, { align: "center" })));
    if (opts.copyLabel) add(opts.copyLabel, { align: "center", bold: true });
    if (tx.status === "void") add("*** VOID / BATAL ***", { align: "center", bold: true });
    hr("=");
    add(lr("No", tx.receipt_no, w));
    add(lr("Tanggal", fmtDT(tx.created_at), w));
    if (tx.cashier_name) add(lr("Kasir", tx.cashier_name, w));
    if (tx.customer_name) add(lr("Tamu", tx.customer_name, w));
    if (tx.customer_phone) add(lr("HP", tx.customer_phone, w));
    if (tx.customer_note) wrap("Ket: " + tx.customer_note, w).forEach((x) => add(x));
    hr();
    for (const it of items) {
      wrap(it.name, w).forEach((x) => add(x, { bold: true }));
      const q = Number(it.qty);
      add(lr(`  ${q % 1 ? q.toLocaleString("id-ID") : q} ${UNIT[it.unit] || it.unit} x ${num(it.price)}`, num(it.line_total), w));
      if (it.item_ref) wrap("Ref: " + it.item_ref, w - 2).forEach((x) => add("  " + x));
      if (it.due_at && (it.unit === "day" || it.unit === "hour")) add(`  Kembali: ${fmtDT(it.due_at)}`);
      if (it.note) wrap(it.note, w - 2).forEach((x) => add("  " + x));
    }
    hr();
    add(lr("Subtotal", num(tx.subtotal), w));
    if (Number(tx.discount)) add(lr("Diskon", "-" + num(tx.discount), w));
    if (Number(tx.tax)) add(lr(`Pajak ${Number(st.tax_percent) || ""}%`, num(tx.tax), w));
    add(lr("TOTAL", rupiah(tx.total), w), { bold: true });
    add(lr("Bayar (" + tx.payment_method + ")", num(tx.amount_paid), w));
    if (Number(tx.change_amount)) add(lr("Kembalian", num(tx.change_amount), w));
    hr("=");
    if (st.receipt_footer) String(st.receipt_footer).split("\n").forEach((ln) => wrap(ln, w).forEach((x) => add(x, { align: "center" })));
    add("");
    return L;
  }

  // ── ESC/POS encoding ─────────────────────────────────────
  function toEscPos(lines, { cut = true, copies = 1 } = {}) {
    const out = [];
    const push = (...b) => out.push(...b);
    const text = (s) => { for (const ch of s) push(ch.charCodeAt(0) & 0x7f); };
    for (let c = 0; c < Math.max(1, copies); c++) {
      push(0x1b, 0x40); // init
      for (const l of lines) {
        push(0x1b, 0x61, l.align === "center" ? 1 : l.align === "right" ? 2 : 0);
        push(0x1b, 0x45, l.bold ? 1 : 0);
        push(0x1d, 0x21, l.big ? 0x11 : 0x00);
        text(l.big ? l.t.slice(0, Math.floor((getCfg().width || 32) / 2)) : l.t);
        push(0x0a);
      }
      push(0x1b, 0x61, 0, 0x1d, 0x21, 0, 0x1b, 0x45, 0);
      push(0x1b, 0x64, 4); // feed 4 lines
      if (cut) push(0x1d, 0x56, 0x42, 0x00);
    }
    return new Uint8Array(out);
  }
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

  function toHtml(lines) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<div class="rcpt">${lines.map((l) => `<div class="rl ${l.align}${l.bold ? " b" : ""}${l.big ? " big" : ""}">${esc(l.t) || "&nbsp;"}</div>`).join("")}</div>`;
  }

  // ── transports ───────────────────────────────────────────
  let webDev = null, webChar = null;
  const BLE_SERVICES = [
    0x18f0, 0xff00, 0xffe0, 0xfee7, 0xae30, 0xe7e1,
    "000018f0-0000-1000-8000-00805f9b34fb", "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
    "49535343-fe7d-4ae5-8fa9-9fafd205e455", "0000ff00-0000-1000-8000-00805f9b34fb",
  ];
  async function webConnect(forcePick) {
    if (!navigator.bluetooth) throw new Error("Browser ini tidak mendukung Web Bluetooth. Pakai aplikasi Android PX POS atau RawBT.");
    if (forcePick || !webDev) {
      webDev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      webChar = null;
      setCfg({ name: webDev.name || "Printer BLE" });
    }
    if (!webDev.gatt.connected) { await webDev.gatt.connect(); webChar = null; }
    if (!webChar) {
      for (const svc of await webDev.gatt.getPrimaryServices()) {
        for (const ch of await svc.getCharacteristics()) {
          if (ch.properties.writeWithoutResponse || ch.properties.write) { webChar = ch; break; }
        }
        if (webChar) break;
      }
      if (!webChar) throw new Error("Printer tidak punya karakteristik tulis (bukan printer BLE ESC/POS?)");
    }
    return webChar;
  }
  async function webPrint(bytes) {
    const ch = await webConnect(false);
    for (let i = 0; i < bytes.length; i += 180) {
      const part = bytes.slice(i, i + 180);
      if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(part);
      else await ch.writeValue(part);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function rawbtPrint(bytes) {
    const data = b64(bytes);
    if (isNative()) window.location.href = "rawbt:base64," + data;
    else window.location.href = "intent:base64," + data + "#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;";
  }

  function systemPrint(lines) {
    let area = document.getElementById("print-area");
    if (!area) { area = document.createElement("div"); area.id = "print-area"; document.body.appendChild(area); }
    area.innerHTML = toHtml(lines);
    area.style.setProperty("--rw", (getCfg().width >= 48 ? 80 : 58) + "mm");
    setTimeout(() => window.print(), 50);
  }

  function resolveMethod(cfg) {
    if (cfg.method !== "auto") return cfg.method;
    if (isNative() && nativePlugin() && cfg.address) return "native";
    if (!isNative() && navigator.bluetooth && cfg.name) return "webbt";
    return "system";
  }

  async function print(lines, override) {
    const cfg = Object.assign(getCfg(), override || {});
    const method = resolveMethod(cfg);
    const bytes = toEscPos(lines, { cut: cfg.cut, copies: cfg.copies });
    if (method === "native") {
      const p = nativePlugin();
      if (!p) throw new Error("Bluetooth native hanya ada di aplikasi Android PX POS");
      if (!cfg.address) throw new Error("Pilih printer dulu di Pengaturan → Printer");
      await p.print({ address: cfg.address, data: b64(bytes) });
    } else if (method === "webbt") await webPrint(bytes);
    else if (method === "rawbt") rawbtPrint(bytes);
    else systemPrint(lines);
    return method;
  }

  async function listPaired() {
    const p = nativePlugin();
    if (!p) throw new Error("Daftar printer Bluetooth hanya ada di aplikasi Android PX POS");
    const r = await p.listPaired();
    return r.devices || [];
  }

  function testLines(st) {
    const w = getCfg().width;
    return buildReceipt({ receipt_no: "TEST-0001", created_at: new Date(), subtotal: 50000, discount: 0, tax: 0, total: 50000,
      payment_method: "Cash", amount_paid: 50000, change_amount: 0, customer_name: "Tes Printer" },
      [{ name: "Tes cetak struk " + w + " kolom", unit: "pcs", qty: 1, price: 50000, line_total: 50000 }], st || {});
  }

  window.PXPrinter = { getCfg, setCfg, buildReceipt, toHtml, toEscPos, print, listPaired, webConnect, testLines,
    isNative, hasNative: () => !!nativePlugin(), hasWebBt: () => !!navigator.bluetooth, isAndroid, rupiah, fmtDT, UNIT };
})();
