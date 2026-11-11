// In-memory stand-in for supabase-js used by the UI smoke test (tools/ui-smoke/run.py).
(function () {
  const now = () => new Date().toISOString();
  const uid = "u-owner";
  const DB = {
    profiles: [{ id: uid, full_name: "Owner Test", username: null, role: window.MOCK_ROLE || "owner", active: true, created_at: now() },
               { id: "u-k1", full_name: "Kasir Satu", username: "kasir1", role: "cashier", active: true, created_at: now() }],
    settings: [{ id: 1, business_name: "PX Gili", address: "Gili Trawangan", phone: "0812", receipt_header: "", receipt_footer: "Please keep this receipt.", thank_you: "Thank you for your visit!", receipt_prefix: "PX",
      tax_percent: 10, tax_label: "Tax", service_percent: 5, service_label: "Service", logo_data: "", max_discount_pct: 100, payment_methods: ["Cash", "QRIS", "Transfer", "Card"],
      report_enabled: false, report_hour: 22, report_emails: [] }],
    report_log: [],
    categories: [
      { code: "rent_bike", name: "Rent Bike", icon: "🚲", color: "#16a34a", is_rental: true, sort: 1, active: true },
      { code: "ebike", name: "E-Bike", icon: "⚡", color: "#f59e0b", is_rental: true, sort: 2, active: true },
      { code: "laundry", name: "Laundry", icon: "🧺", color: "#6366f1", is_rental: false, sort: 3, active: true },
      { code: "massage", name: "Massage", icon: "💆", color: "#db2777", is_rental: false, sort: 4, active: true },
      { code: "snorkeling", name: "Snorkeling", icon: "🤿", color: "#0284c7", is_rental: false, sort: 5, active: true }],
    services: [
      ["s1", "rent_bike", "Bike Rental (per day)", 50000, "day"], ["s2", "ebike", "E-Bike Rental (per day)", 250000, "day"],
      ["s3", "laundry", "Laundry (per kg)", 15000, "kg"], ["s4", "massage", "Massage", 350000, "session"],
      ["s5", "snorkeling", "Private Snorkeling 2 Hours", 1100000, "trip"], ["s6", "snorkeling", "Private Snorkeling 3 Hours", 1300000, "trip"],
      ["s7", "snorkeling", "Private Snorkeling 4 Hours", 1500000, "trip"]].map(([id, category, name, price, unit], i) => ({ id, category, name, price, unit, description: "", duration_hours: null, active: true, sort: i })),
    transactions: [], transaction_items: [], shifts: [],
  };
  window.MOCK_DB = DB; window.MOCK_CALLS = [];
  let seq = 0, shift = null;
  const join = (t) => Object.assign({}, t, { cashier: { full_name: DB.profiles.find((p) => p.id === t.cashier_id)?.full_name }, items: DB.transaction_items.filter((i) => i.transaction_id === t.id) });
  const unitHours = { day: 24, hour: 1 };

  function query(table) {
    const st = { table, filters: [], single: false, maybe: false, op: "select", row: null, limit: null };
    const q = {
      select() { return q; }, order() { return q; }, limit(n) { st.limit = n; return q; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return q; }, gte(k, v) { st.filters.push((r) => r[k] >= v); return q; }, lt(k, v) { st.filters.push((r) => r[k] < v); return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.maybe = true; return q; },
      update(row) { st.op = "update"; st.row = row; return q; }, insert(row) { st.op = "insert"; st.row = row; return q; }, delete() { st.op = "delete"; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      window.MOCK_CALLS.push(table + ":" + st.op);
      let rows = DB[table];
      if (st.op === "insert") { const r = Object.assign({ id: "n" + Date.now() }, st.row); rows.push(r); return { data: r, error: null }; }
      let hit = rows.filter((r) => st.filters.every((f) => f(r)));
      if (st.op === "update") { hit.forEach((r) => Object.assign(r, st.row)); return { data: hit, error: null }; }
      if (st.op === "delete") { DB[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      if (table === "transactions") hit = hit.map(join).sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (table === "transaction_items") hit = hit.map((i) => Object.assign({}, i, { tx: DB.transactions.find((t) => t.id === i.transaction_id) }));
      if (table === "shifts") hit = hit.map((s) => Object.assign({}, s, { cashier: { full_name: "Owner Test" } }));
      if (st.single || st.maybe) return { data: hit[0] || null, error: st.single && !hit[0] ? { message: "not found" } : null };
      return { data: hit, error: null };
    }
    return q;
  }
  function summary(s) {
    const tx = DB.transactions.filter((t) => t.shift_id === s.id), paid = tx.filter((t) => t.status === "paid");
    const by = {}; paid.forEach((t) => by[t.payment_method] = (by[t.payment_method] || 0) + t.total);
    return { shift: s, count: paid.length, void_count: tx.length - paid.length, total: paid.reduce((a, t) => a + t.total, 0), cash_sales: by.Cash || 0, by_method: by };
  }
  const RPC = {
    shift_summary: () => shift ? summary(shift) : null,
    open_shift: ({ p_cash }) => { shift = { id: "sh1", cashier_id: uid, opened_at: now(), opening_cash: p_cash, closed_at: null }; DB.shifts.push(shift); return shift.id; },
    close_shift: ({ p_cash, p_note }) => { const s = shift; const sm = summary(s); Object.assign(s, { closed_at: now(), closing_cash: p_cash, expected_cash: s.opening_cash + sm.cash_sales, note: p_note }); shift = null; return summary(s); },
    create_sale: ({ p }) => {
      const st = DB.settings[0]; let sub = 0;
      const items = p.items.map((it) => { const s = DB.services.find((x) => x.id === it.service_id); const price = it.price ?? s.price; sub += Math.round(price * it.qty); return { s, price, it }; });
      if (p.discount > sub) throw { message: "Diskon melebihi subtotal" };
      const st0 = DB.settings[0], srv = Math.round((sub - p.discount) * st0.service_percent / 100), tax = Math.round((sub - p.discount + srv) * st0.tax_percent / 100);
      const total = sub - p.discount + srv + tax; if (p.amount_paid < total) throw { message: "Pembayaran kurang" };
      const id = "t" + (++seq), receipt_no = "PX261111-" + String(seq).padStart(4, "0");
      DB.transactions.push({ id, receipt_no, created_at: now(), cashier_id: uid, shift_id: shift?.id || null, customer_name: p.customer_name, customer_phone: p.customer_phone, customer_note: p.customer_note,
        subtotal: sub, discount: p.discount, service_charge: srv, tax, total, payment_method: p.payment_method, amount_paid: p.amount_paid, change_amount: p.amount_paid - total, status: "paid" });
      items.forEach(({ s, price, it }, k) => { const cat = DB.categories.find((c) => c.code === s.category); const start = new Date();
        DB.transaction_items.push({ id: id + "-" + k, transaction_id: id, service_id: s.id, category: s.category, name: s.name, unit: s.unit, price, qty: it.qty, line_total: Math.round(price * it.qty), item_ref: it.item_ref, note: "",
          start_at: start.toISOString(), due_at: unitHours[s.unit] ? new Date(+start + it.qty * unitHours[s.unit] * 3600e3).toISOString() : null, rental_status: cat.is_rental ? "out" : "none" }); });
      return { id, receipt_no, total, change: p.amount_paid - total };
    },
    void_sale: ({ p_id, p_reason }) => { const t = DB.transactions.find((x) => x.id === p_id); t.status = "void"; t.void_reason = p_reason; },
    return_rental: ({ p_item }) => { DB.transaction_items.find((x) => x.id === p_item).rental_status = "returned"; },
    sales_report: () => {
      const paid = DB.transactions.filter((t) => t.status === "paid"); const items = DB.transaction_items.filter((i) => paid.some((t) => t.id === i.transaction_id));
      const grp = (arr, key, val) => Object.values(arr.reduce((m, x) => { const k = key(x); m[k] = m[k] || { k, total: 0, qty: 0, count: 0, x }; m[k].total += val(x); m[k].qty += Number(x.qty || 0); m[k].count++; return m; }, {}));
      return { count: paid.length, void_count: DB.transactions.length - paid.length, gross: paid.reduce((a, t) => a + t.subtotal, 0), discount: paid.reduce((a, t) => a + t.discount, 0), service: paid.reduce((a, t) => a + t.service_charge, 0), tax: paid.reduce((a, t) => a + t.tax, 0), void_total: 0, total: paid.reduce((a, t) => a + t.total, 0),
        by_category: grp(items, (i) => i.category, (i) => i.line_total).map((g) => ({ category: g.k, qty: g.qty, total: g.total })),
        by_service: grp(items, (i) => i.name, (i) => i.line_total).map((g) => ({ category: g.x.category, name: g.k, qty: g.qty, total: g.total })),
        by_method: grp(paid, (t) => t.payment_method, (t) => t.total).map((g) => ({ method: g.k, count: g.count, total: g.total })),
        by_cashier: [{ cashier: "Owner Test", count: paid.length, total: paid.reduce((a, t) => a + t.total, 0) }],
        by_day: paid.length ? [{ day: new Date().toISOString().slice(0, 10), count: paid.length, total: paid.reduce((a, t) => a + t.total, 0) }] : [] };
    },
  };
  let authCb = null;
  const session = { user: { id: uid, email: "owner@test" } };
  window.supabase = { createClient: () => ({
    auth: {
      onAuthStateChange(cb) { authCb = cb; setTimeout(() => cb("INITIAL_SESSION", window.MOCK_LOGGED_OUT ? null : session), 0); return { data: { subscription: {} } }; },
      async signInWithPassword() { setTimeout(() => authCb("SIGNED_IN", session), 0); return { error: null }; },
      async signOut() { setTimeout(() => authCb("SIGNED_OUT", null), 0); return { error: null }; },
      async signUp() { return { data: { session: null }, error: null }; }, async updateUser() { return { error: null }; },
    },
    from: (t) => query(t),
    async rpc(name, args) { window.MOCK_CALLS.push("rpc:" + name); try { return { data: RPC[name](args || {}), error: null }; } catch (e) { return { data: null, error: e }; } },
    functions: { async invoke(n, { body }) { window.MOCK_CALLS.push("fn:" + n + ":" + (body.action || body.day)); return { data: { ok: true, recipients: DB.settings[0].report_emails }, error: null }; } },
  }) };
})();
