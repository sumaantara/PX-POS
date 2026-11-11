"""UI smoke test: runs www/ in headless Chrome against an in-memory Supabase mock.
Cashier mode (Android app) on tablet + phone, back-office mode (website) on desktop + phone.
Usage: python3 tools/ui-smoke/run.py [outdir]"""
import os, sys, mimetypes
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
WWW = os.path.join(ROOT, "www")
MOCK = os.path.join(HERE, "mock-supabase.js")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pxpos-smoke"
os.makedirs(OUT, exist_ok=True)
errors, steps = [], []

LOGO = os.path.join(OUT, "logo.png")
from PIL import Image, ImageDraw
im = Image.new("RGB", (600, 240), "white"); d = ImageDraw.Draw(im)
d.ellipse((20, 20, 220, 220), fill="black"); d.rectangle((260, 80, 580, 160), fill="black"); im.save(LOGO)

def serve(route):
    path = route.request.url.split("pxpos.test/", 1)[1].split("?")[0] or "index.html"
    f = MOCK if path == "vendor/supabase.js" else os.path.join(WWW, path)
    if not os.path.exists(f):
        return route.fulfill(status=404, body="nf")
    route.fulfill(status=200, body=open(f, "rb").read(), headers={"content-type": mimetypes.guess_type(f)[0] or "application/octet-stream"})

def check(cond, msg):
    steps.append(("OK  " if cond else "FAIL") + " " + msg)

def page(b, name, vp, mode, extra=""):
    ctx = b.new_context(viewport=vp, device_scale_factor=1, accept_downloads=True)
    pg = ctx.new_page()
    pg.on("console", lambda m: m.type == "error" and errors.append(f"[{name}] {m.text}"))
    pg.on("pageerror", lambda e: errors.append(f"[{name}] pageerror {e}"))
    pg.route("http://pxpos.test/**", serve)
    pg.add_init_script(f"window.PX_FORCE_MODE = '{mode}'; window.print = () => {{ window.__printed = (window.__printed||0)+1 }};" + extra)
    pg.goto("http://pxpos.test/index.html")
    return ctx, pg

SALE = """async () => { const c = window.supabase.createClient(); await c.rpc('open_shift', {p_cash: 0});
  await c.rpc('create_sale', {p: {customer_name:'Anna', payment_method:'QRIS', discount:0, amount_paid: 1e9, items:[{service_id:'s1', qty:2, item_ref:'B-01'},{service_id:'s4', qty:1}]}}); }"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    # ───────── cashier app ─────────
    for name, vp in [("cashier-tablet", {"width": 1280, "height": 800}), ("cashier-phone", {"width": 390, "height": 844})]:
        phone = "phone" in name
        ctx, pg = page(b, name, vp, "cashier")
        shot = lambda n: pg.screenshot(path=f"{OUT}/{name}-{n}.png")
        pg.wait_for_selector(".svc", timeout=5000)
        check(pg.locator(".svc").count() == 7, f"{name}: 7 services")
        check("No open shift" in pg.inner_text("main"), f"{name}: shift warning in English")
        nav_txt = pg.inner_text(".bnav" if phone else "nav.nav")
        check("Back office" not in pg.inner_text("body") or "Cashier" in pg.inner_text(".top"), f"{name}: cashier badge")
        check("Dashboard" not in nav_txt and "Services" not in nav_txt, f"{name}: no back-office menus in app ({nav_txt.split()})")
        shot("01-sale")
        nav = (lambda v: pg.click(f'.bnav [data-v="{v}"]')) if phone else (lambda v: pg.click(f'nav.nav [data-v="{v}"]'))
        nav("shift"); pg.fill("#open-cash", "200000"); pg.click('[data-act="shift-open"]'); pg.wait_for_selector("text=Current shift")
        nav("pos"); pg.wait_for_selector(".svc")
        pg.click('.svc[data-id="s1"]')
        if phone: pg.click(".cartbar")
        q = pg.locator('[data-bind="qty"]').first; q.fill("3"); q.dispatch_event("change")
        pg.locator('[data-bind="ref"]').first.fill("B-07")
        if phone: pg.click('[data-act="cart-close"]')
        pg.click('.svc[data-id="s5"]'); pg.click('.svc[data-id="s3"]')
        if phone: pg.click(".cartbar")
        q3 = pg.locator('[data-bind="qty"]').nth(2); q3.fill("2.5"); q3.dispatch_event("change")
        pg.locator('[data-bind="cust"][data-f="name"]').fill("John")
        pg.locator('[data-bind="disc"]').fill("50000")
        pg.locator('[data-bind="paid"]').fill("2,000,000")
        tot = pg.inner_text("#totals")
        # 1,287,500 - 50,000 = 1,237,500; service 5% = 61,875; tax 10% of 1,299,375 = 129,938; total 1,429,313; change 570,687
        check(all(x in tot for x in ["1,287,500", "61,875", "129,938", "1,429,313", "570,687"]), f"{name}: service+tax totals -> {tot!r}")
        shot("02-cart")
        pg.click('[data-act="checkout"]'); pg.wait_for_selector(".rcpt")
        rc = pg.inner_text(".rcpt")
        check(all(x in rc for x in ["Receipt", "PX261111-0001", "Ref: B-07", "Return by", "Service 5%", "Tax 10%", "1,429,313", "Thank you for your visit!", "Change"]), f"{name}: English receipt")
        check(pg.locator('.modal [data-act="void"]').count() == 0, f"{name}: no void button in cashier app")
        shot("03-receipt")
        pg.click('.modal [data-act="print"]'); pg.wait_for_timeout(300)
        check(pg.evaluate("window.__printed||0") >= 1, f"{name}: print works")
        pg.click('.modal [data-act="m-close"]')
        nav("tx"); pg.wait_for_selector('[data-act="tx-open"]')
        check(pg.locator('[data-bind="tx-from"]').count() == 0, f"{name}: history has no date range (app)")
        nav("rental"); pg.wait_for_selector('[data-act="return"]'); check("B-07" in pg.inner_text("main"), f"{name}: rental listed")
        pg.click('[data-act="return"]'); pg.click('[data-act="m-yes"]'); pg.wait_for_selector("text=Everything is back")
        nav("set"); pg.wait_for_selector("text=Receipt printer"); shot("04-settings")
        nav("shift"); pg.wait_for_selector("#close-cash"); pg.fill("#close-cash", "1700000"); pg.click('[data-act="shift-close"]'); pg.click('[data-act="m-yes"]')
        pg.wait_for_selector("text=Shift summary")
        # expected = 200,000 + 1,429,313 = 1,629,313 ; counted 1,700,000 -> +70,687
        check("70,687" in pg.inner_text(".modal"), f"{name}: shift difference +70,687")
        shot("05-shift")
        ctx.close()

    # ───────── back office (website) ─────────
    for name, vp in [("bo-desktop", {"width": 1366, "height": 860}), ("bo-phone", {"width": 390, "height": 844})]:
        ctx, pg = page(b, name, vp, "backoffice")
        shot = lambda n: pg.screenshot(path=f"{OUT}/{name}-{n}.png")
        pg.wait_for_selector(".kpi", timeout=5000)
        pg.evaluate(SALE)
        nav = lambda v: pg.click(f'nav.nav [data-v="{v}"]')
        nav("tx"); nav("dash"); pg.wait_for_selector(".kpi")
        nav_txt = pg.inner_text("nav.nav")
        check("Sale" not in nav_txt.split() and "Services & prices" in nav_txt, f"{name}: back-office menus only")
        check(pg.locator(".svc").count() == 0 and pg.locator(".bnav").count() == 0, f"{name}: no cashier screens")
        check("Rp 519,750" in pg.inner_text("main"), f"{name}: dashboard total")
        shot("01-dash")
        nav("report"); pg.wait_for_selector("text=By service"); shot("02-report")
        with pg.expect_download() as dl: pg.click('[data-act="rep-csv"]')
        csv = open(dl.value.path(), encoding="utf-8-sig").read()
        check("Receipt service" in csv and "Bike Rental (per day)" in csv, f"{name}: CSV export")
        nav("tx"); pg.wait_for_selector('[data-act="tx-open"]'); pg.locator('[data-act="tx-open"]').first.click(); pg.wait_for_selector(".rcpt")
        check(pg.locator('.modal [data-act="void"]').count() == 1, f"{name}: void available in back office")
        pg.click('.modal [data-act="void"]'); pg.fill("#pr-in", "test"); pg.click('[data-act="m-yes"]'); pg.wait_for_selector(".modal .badge.bad")
        pg.click('.modal [data-act="m-close"]')
        nav("services"); pg.click('.li[data-act="svc-edit"][data-id="s3"]')
        pg.fill('form[data-form="svc"] [name="price"]', "20,000"); pg.click('form[data-form="svc"] button[type="submit"]'); pg.wait_for_timeout(200)
        check("Rp 20,000" in pg.inner_text("main"), f"{name}: price edit (typed 20,000)")
        nav("users"); pg.wait_for_selector('[data-act="user-new"]'); pg.click('[data-act="user-new"]')
        pg.fill('[name="full_name"]', "Cashier Two"); pg.fill('[name="username"]', "cashier2"); pg.fill('[name="password"]', "secret123")
        pg.click('form[data-form="user"] button[type="submit"]'); pg.wait_for_timeout(200)
        check("fn:admin-users:create" in pg.evaluate("window.MOCK_CALLS"), f"{name}: create cashier")
        nav("store"); pg.wait_for_selector('form[data-form="store"]')
        pg.set_input_files('[data-bind="logo-file"]', LOGO); pg.wait_for_selector(".rcpt .rlogo", timeout=5000)
        check(pg.evaluate("window.MOCK_DB.settings[0].logo_data.startsWith('data:image/')"), f"{name}: logo uploaded")
        pg.fill('[name="service_percent"]', "7"); pg.fill('[name="tax_percent"]', "11"); pg.fill('[name="thank_you"]', "Terima kasih & see you again!")
        pg.click('form[data-form="store"] button[type="submit"]'); pg.wait_for_timeout(300)
        st = pg.evaluate("window.MOCK_DB.settings[0]")
        check(st["service_percent"] == 7 and st["tax_percent"] == 11, f"{name}: tax/service saved")
        check("Service 7%" in pg.inner_text(".rcpt") and "Tax 11%" in pg.inner_text(".rcpt"), f"{name}: receipt preview updates")
        pg.fill('[name="report_emails"]', "owner@px.test, manager@px.test\nbad-email"); pg.click('form[data-form="email"] button[type="submit"]'); pg.wait_for_timeout(200)
        check(pg.evaluate("window.MOCK_DB.settings[0].report_emails.length") == 0, f"{name}: invalid email rejected")
        pg.fill('[name="report_emails"]', "owner@px.test, manager@px.test"); pg.check('[name="report_enabled"]'); pg.select_option('[name="report_hour"]', "21")
        pg.click('form[data-form="email"] button[type="submit"]'); pg.wait_for_timeout(200)
        st = pg.evaluate("window.MOCK_DB.settings[0]")
        check(st["report_emails"] == ["owner@px.test", "manager@px.test"] and st["report_enabled"] and st["report_hour"] == 21, f"{name}: email settings saved")
        pg.click('[data-act="email-now"]'); pg.wait_for_timeout(300)
        check(any(c.startswith("fn:daily-report:") for c in pg.evaluate("window.MOCK_CALLS")), f"{name}: send-now calls daily-report")
        shot("03-settings")
        # cashier-app escpos with logo (raster bytes present)
        n = pg.evaluate("async () => { const L = PXPrinter.buildReceipt({receipt_no:'X',created_at:new Date(),subtotal:1,discount:0,service_charge:0,tax:0,total:1,payment_method:'Cash',amount_paid:1,change_amount:0},[],MOCK_DB.settings[0]); const b = await PXPrinter.toEscPos(L); const i = b.findIndex((v,k)=>v===0x1d&&b[k+1]===0x76&&b[k+2]===0x30); return [b.length, i]; }")
        check(n[1] >= 0 and n[0] > 2000, f"{name}: ESC/POS includes raster logo ({n[0]} bytes)")
        ctx.close()

    # cashier role on the website → blocked
    ctx, pg = page(b, "bo-cashier", {"width": 1280, "height": 800}, "backoffice", "window.MOCK_ROLE='cashier';")
    pg.wait_for_selector("text=Back office is for owners and admins"); check(True, "cashier blocked from back office website")
    ctx.close()
    ctx, pg = page(b, "login", {"width": 390, "height": 844}, "cashier", "window.MOCK_LOGGED_OUT = true;")
    pg.wait_for_selector('form[data-form="login"]'); pg.screenshot(path=f"{OUT}/login-cashier.png")
    check("Create an account" not in pg.inner_text("body"), "cashier app login has no self-registration")
    ctx.close()
    b.close()

print("\n".join(steps))
print("console errors:", errors or "none")
sys.exit(1 if errors or any(s.startswith("FAIL") for s in steps) else 0)
