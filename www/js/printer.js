/* PX POS — receipt layout + printing (ESC/POS over Bluetooth, RawBT, or the system print dialog) */
(function () {
  "use strict";
  const LS_KEY = "pxpos.printer";
  const defaults = { method: "auto", address: "", name: "", width: 32, copies: 1, autoPrint: false, cut: true, logo: true };
  const getCfg = () => { try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); } catch { return { ...defaults }; } };
  const setCfg = (c) => { try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(getCfg(), c))); } catch {} };

  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const nativePlugin = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BtPrinter;
  const isAndroid = /Android/i.test(navigator.userAgent);

  // ── text helpers ─────────────────────────────────────────
  const ascii = (s) => String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/×/g, "x")
    .replace(/[^\x20-\x7E\n]/g, "");
  const num = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
  const rupiah = (n) => "Rp " + num(n);
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
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDT = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${p(x.getDate())} ${MON[x.getMonth()]} ${x.getFullYear()} ${p(x.getHours())}:${p(x.getMinutes())}`; };
  const UNIT = { day: "day", hour: "hour", session: "session", kg: "kg", pcs: "pcs", trip: "trip", person: "person" };
  const unitLabel = (u, q) => { const l = UNIT[u] || u; return Number(q) === 1 || ["kg", "pcs"].includes(l) ? l : l + "s"; };

  // ── receipt model: list of {t, align, bold, big} or {logo} ─────────
  function buildReceipt(tx, items, st, opts = {}) {
    const cfg = getCfg();
    const w = opts.width || cfg.width || 32;
    const L = [];
    const add = (t, o = {}) => L.push(Object.assign({ t: ascii(t), align: "left", bold: false, big: false }, o));
    const hr = (c = "-") => add(c.repeat(w));
    if (st.logo_data && cfg.logo !== false && opts.logo !== false) L.push({ logo: st.logo_data, t: "" });
    const hasLogo = L.length > 0;
    if (st.business_name && !(hasLogo && st.receipt_show_name === false)) add(st.business_name, { align: "center", bold: true, big: true });
    for (const s of [st.address, st.phone].filter(Boolean)) wrap(s, w).forEach((x) => add(x, { align: "center" }));
    if (st.receipt_header) String(st.receipt_header).split("\n").forEach((ln) => wrap(ln, w).forEach((x) => add(x, { align: "center" })));
    if (opts.copyLabel) add(opts.copyLabel, { align: "center", bold: true });
    if (tx.status === "void") add("*** VOID ***", { align: "center", bold: true });
    hr("=");
    add(lr("Receipt", tx.receipt_no, w));
    add(lr("Date", fmtDT(tx.created_at), w));
    if (tx.cashier_name) add(lr("Cashier", tx.cashier_name, w));
    if (tx.customer_name) add(lr("Guest", tx.customer_name, w));
    if (tx.customer_phone) add(lr("Phone", tx.customer_phone, w));
    if (tx.customer_note) wrap("Note: " + tx.customer_note, w).forEach((x) => add(x));
    hr();
    for (const it of items) {
      wrap(it.name, w).forEach((x) => add(x, { bold: true }));
      const q = Number(it.qty);
      add(lr(`  ${q.toLocaleString("en-US")} ${unitLabel(it.unit, q)} x ${num(it.price)}`, num(it.line_total), w));
      if (it.item_ref) wrap("Ref: " + it.item_ref, w - 2).forEach((x) => add("  " + x));
      if (it.due_at && (it.unit === "day" || it.unit === "hour")) add(`  Return by: ${fmtDT(it.due_at)}`);
      if (it.note) wrap(it.note, w - 2).forEach((x) => add("  " + x));
    }
    hr();
    add(lr("Subtotal", num(tx.subtotal), w));
    if (Number(tx.discount)) add(lr("Discount", "-" + num(tx.discount), w));
    if (Number(tx.service_charge)) add(lr(`${st.service_label || "Service"} ${Number(st.service_percent) || ""}%`, num(tx.service_charge), w));
    if (Number(tx.tax)) add(lr(`${st.tax_label || "Tax"} ${Number(st.tax_percent) || ""}%`, num(tx.tax), w));
    if (Number(tx.card_fee)) add(lr(`${st.card_fee_label || "Card fee"}${Number(st.card_fee_percent) ? " " + Number(st.card_fee_percent) + "%" : ""}`, num(tx.card_fee), w));
    add(lr("TOTAL", rupiah(tx.total), w), { bold: true });
    add(lr("Paid (" + tx.payment_method + ")", num(tx.amount_paid), w));
    if (Number(tx.change_amount)) add(lr("Change", num(tx.change_amount), w));
    hr("=");
    if (st.thank_you) String(st.thank_you).split("\n").forEach((ln) => wrap(ln, w).forEach((x) => add(x, { align: "center", bold: true })));
    if (st.receipt_footer) String(st.receipt_footer).split("\n").forEach((ln) => wrap(ln, w).forEach((x) => add(x, { align: "center" })));
    add("");
    L.cols = w;
    return L;
  }

  // ── logo → ESC/POS raster (GS v 0), Atkinson dithering ─────────
  const logoCache = new Map();
  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Logo image could not be loaded")); im.src = src; });
  }
  async function rasterLogo(dataUrl, paperDots) {
    const key = paperDots + "|" + dataUrl.length + "|" + dataUrl.slice(-40);
    if (logoCache.has(key)) return logoCache.get(key);
    const im = await loadImage(dataUrl);
    let w = Math.min(im.naturalWidth, Math.round(paperDots * 0.7));
    let h = Math.round(im.naturalHeight * w / im.naturalWidth);
    if (h > 240) { w = Math.round(w * 240 / h); h = 240; }
    w = Math.max(8, Math.ceil(w / 8) * 8);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    const bytesPerRow = w / 8, bits = new Uint8Array(bytesPerRow * h);
    const spread = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = lum[i], nw = old < 128 ? 0 : 255, err = (old - nw) / 8;
      if (nw === 0) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      for (const [dx, dy] of spread) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < w && yy < h) lum[yy * w + xx] += err; }
    }
    const head = [0x1b, 0x61, 1, 0x1d, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, h & 0xff, h >> 8];
    const out = new Uint8Array(head.length + bits.length + 1);
    out.set(head, 0); out.set(bits, head.length); out[out.length - 1] = 0x0a;
    logoCache.set(key, out);
    return out;
  }

  // ── ESC/POS encoding ─────────────────────────────────────
  async function toEscPos(lines, { cut = true, copies = 1 } = {}) {
    const width = getCfg().width || 32, dots = width >= 48 ? 576 : 384;
    const out = [];
    const push = (...b) => { for (const x of b) out.push(x); };
    const text = (s) => { for (const ch of s) push(ch.charCodeAt(0) & 0x7f); };
    for (let c = 0; c < Math.max(1, copies); c++) {
      push(0x1b, 0x40);
      for (const l of lines) {
        if (l.logo) { try { const r = await rasterLogo(l.logo, dots); for (const b of r) out.push(b); } catch (e) { console.warn(e); } continue; }
        push(0x1b, 0x61, l.align === "center" ? 1 : l.align === "right" ? 2 : 0);
        push(0x1b, 0x45, l.bold ? 1 : 0);
        push(0x1d, 0x21, l.big ? 0x11 : 0x00);
        text(l.big ? l.t.slice(0, Math.floor(width / 2)) : l.t);
        push(0x0a);
      }
      push(0x1b, 0x61, 0, 0x1d, 0x21, 0, 0x1b, 0x45, 0);
      push(0x1b, 0x64, 4);
      if (cut) push(0x1d, 0x56, 0x42, 0x00);
    }
    return new Uint8Array(out);
  }
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

  function toHtml(lines) {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const cols = lines.cols || getCfg().width || 32;
    return `<div class="rcpt" style="--cols:${cols}">${lines.map((l) => l.logo
      ? `<div class="rl center"><img src="${esc(l.logo)}" alt="" class="rlogo"></div>`
      : `<div class="rl ${l.align}${l.bold ? " b" : ""}${l.big ? " big" : ""}">${esc(l.t) || "&nbsp;"}</div>`).join("")}</div>`;
  }
  const toText = (lines, w = 32) => lines.filter((l) => !l.logo).map((l) => l.align === "center" ? l.t.padStart(Math.floor((w + l.t.length) / 2)) : l.t).join("\n");

  // ── transports ───────────────────────────────────────────
  let webDev = null, webChar = null;
  const BLE_SERVICES = [
    0x18f0, 0xff00, 0xffe0, 0xfee7, 0xae30, 0xe7e1,
    "000018f0-0000-1000-8000-00805f9b34fb", "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
    "49535343-fe7d-4ae5-8fa9-9fafd205e455", "0000ff00-0000-1000-8000-00805f9b34fb",
  ];
  async function webConnect(forcePick) {
    if (!navigator.bluetooth) throw new Error("This browser can't use Bluetooth printers. Use the PX POS Android app or RawBT.");
    if (forcePick || !webDev) {
      webDev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      webChar = null;
      setCfg({ name: webDev.name || "BLE printer" });
    }
    if (!webDev.gatt.connected) { await webDev.gatt.connect(); webChar = null; }
    if (!webChar) {
      for (const svc of await webDev.gatt.getPrimaryServices()) {
        for (const ch of await svc.getCharacteristics()) {
          if (ch.properties.writeWithoutResponse || ch.properties.write) { webChar = ch; break; }
        }
        if (webChar) break;
      }
      if (!webChar) throw new Error("This doesn't look like a BLE receipt printer (no writable channel)");
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
    setTimeout(() => window.print(), 80);
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
    if (method === "system") { systemPrint(lines); return method; }
    const bytes = await toEscPos(lines, { cut: cfg.cut, copies: cfg.copies });
    if (method === "native") {
      const p = nativePlugin();
      if (!p) throw new Error("Bluetooth printing is only available in the PX POS Android app");
      if (!cfg.address) throw new Error("Choose a printer first in Settings → Printer");
      await p.print({ address: cfg.address, data: b64(bytes) });
    } else if (method === "webbt") await webPrint(bytes);
    else if (method === "rawbt") rawbtPrint(bytes);
    return method;
  }
  async function listPaired() {
    const p = nativePlugin();
    if (!p) throw new Error("The paired-printer list is only available in the PX POS Android app");
    const r = await p.listPaired();
    return r.devices || [];
  }
  function testLines(st) {
    const w = getCfg().width;
    return buildReceipt({ receipt_no: "TEST-0001", created_at: new Date(), subtotal: 50000, discount: 0, service_charge: 0, tax: 0, total: 50000,
      payment_method: "Cash", amount_paid: 50000, change_amount: 0, customer_name: "Printer test" },
      [{ name: `Test print, ${w} columns`, unit: "pcs", qty: 1, price: 50000, line_total: 50000 }], st || {});
  }

  window.PXPrinter = { getCfg, setCfg, buildReceipt, toHtml, toText, toEscPos, print, listPaired, webConnect, testLines, rasterLogo,
    isNative, hasNative: () => !!nativePlugin(), hasWebBt: () => !!navigator.bluetooth, isAndroid, rupiah, num, fmtDT, UNIT, unitLabel };
})();
