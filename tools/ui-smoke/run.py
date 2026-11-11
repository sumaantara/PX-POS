"""UI smoke test: runs www/ in headless Chrome against an in-memory Supabase mock.
Usage: python3 tools/ui-smoke/run.py [outdir]"""
import os, sys, mimetypes
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WWW = os.path.join(ROOT, "www")
MOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock-supabase.js")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pxpos-smoke"
os.makedirs(OUT, exist_ok=True)
errors, steps = [], []

def serve(route):
    path = route.request.url.split("pxpos.test/", 1)[1].split("?")[0] or "index.html"
    f = MOCK if path == "vendor/supabase.js" else os.path.join(WWW, path)
    if not os.path.exists(f):
        return route.fulfill(status=404, body="nf")
    route.fulfill(status=200, body=open(f, "rb").read(), headers={"content-type": mimetypes.guess_type(f)[0] or "application/octet-stream"})

def check(cond, msg):
    steps.append(("OK  " if cond else "FAIL") + " " + msg)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for vp_name, vp in [("tablet", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844})]:
        ctx = b.new_context(viewport=vp, device_scale_factor=1)
        pg = ctx.new_page()
        pg.on("console", lambda m: m.type == "error" and errors.append(f"[{vp_name}] {m.text}"))
        pg.on("pageerror", lambda e: errors.append(f"[{vp_name}] pageerror {e}"))
        pg.route("http://pxpos.test/**", serve)
        pg.add_init_script("window.print = () => { window.__printed = (window.__printed||0)+1 };")
        pg.goto("http://pxpos.test/index.html")
        pg.wait_for_selector(".svc", timeout=5000)
        shot = lambda n: pg.screenshot(path=f"{OUT}/{vp_name}-{n}.png", full_page=False)
        check(pg.locator(".svc").count() == 7, f"{vp_name}: 7 services on POS")
        check("Shift belum dibuka" in pg.inner_text("main"), f"{vp_name}: shift warning shown")
        shot("01-pos")

        # open shift
        pg.click('main [data-act="go"][data-v="shift"]')
        pg.fill("#open-cash", "200000"); pg.click('[data-act="shift-open"]')
        pg.wait_for_selector("text=Shift berjalan")
        check(True, f"{vp_name}: shift opened")
        pg.click('nav [data-act="go"][data-v="pos"]') if vp_name == "tablet" else pg.click('.bnav [data-v="pos"]')
        pg.wait_for_selector(".svc")

        # build a sale
        pg.click('.svc[data-id="s1"]')
        if vp_name == "phone":
            check(pg.locator(".cartbar").is_visible(), "phone: cart bar visible"); pg.click(".cartbar")
        q = pg.locator('[data-bind="qty"]').first
        q.fill("3"); q.dispatch_event("change")
        pg.locator('[data-bind="ref"]').first.fill("B-07")
        if vp_name == "phone": pg.click('[data-act="cart-close"]')
        pg.click('.svc[data-id="s5"]'); pg.click('.svc[data-id="s3"]')
        if vp_name == "phone": pg.click(".cartbar")
        q3 = pg.locator('[data-bind="qty"]').nth(2); q3.fill("2.5"); q3.dispatch_event("change")
        pg.locator('[data-bind="cust"][data-f="name"]').fill("John")
        pg.locator('[data-bind="cust"][data-f="phone"]').fill("08123456789")
        pg.locator('[data-bind="disc"]').fill("50000")
        pg.locator('[data-bind="paid"]').fill("2000000")
        tot = pg.inner_text("#totals")
        check("1.237.500" in tot and "762.500" in tot, f"{vp_name}: totals 1.237.500 / change 762.500 -> {tot!r}")
        shot("02-cart")
        pg.click('[data-act="checkout"]')
        pg.wait_for_selector(".rcpt")
        rc = pg.inner_text(".rcpt")
        check("PX261111-0001" in rc and "B-07" in rc and "1.237.500" in rc, f"{vp_name}: receipt shows no/ref/total")
        shot("03-receipt")
        pg.click('.modal [data-act="print"]'); pg.wait_for_timeout(300)
        check(pg.evaluate("window.__printed||0") >= 1, f"{vp_name}: system print triggered")
        pg.click('.modal [data-act="m-close"]')
        check(pg.locator(".ci").count() == 0, f"{vp_name}: cart cleared after sale")

        # QRIS sale (no cash input)
        pg.click('.svc[data-id="s4"]')
        if vp_name == "phone": pg.click(".cartbar")
        pg.click('[data-act="method"][data-m="QRIS"]')
        check(pg.locator('[data-bind="paid"]').count() == 0, f"{vp_name}: no cash input for QRIS")
        pg.click('[data-act="checkout"]'); pg.wait_for_selector(".rcpt"); pg.click('.modal [data-act="m-close"]')

        nav = (lambda v: pg.click(f'nav.nav [data-v="{v}"]')) if vp_name == "tablet" else (lambda v: pg.click(f'.bnav [data-v="{v}"]'))
        # transactions + void
        nav("tx"); pg.wait_for_selector('[data-act="tx-open"]')
        check(pg.locator('[data-act="tx-open"]').count() == 2, f"{vp_name}: 2 transactions listed")
        shot("04-tx")
        pg.locator('[data-act="tx-open"]').first.click(); pg.wait_for_selector(".rcpt")
        pg.click('.modal [data-act="void"]'); pg.fill("#pr-in", "salah input"); pg.click('[data-act="m-yes"]')
        pg.wait_for_selector(".modal .badge.bad")
        check("VOID" in pg.inner_text(".modal"), f"{vp_name}: void works")
        pg.click('.modal [data-act="m-close"]')

        # rentals
        nav("rental"); pg.wait_for_selector('[data-act="return"]')
        check(pg.locator('[data-act="return"]').count() == 1 and "B-07" in pg.inner_text("main"), f"{vp_name}: rental B-07 out")
        shot("05-rental")
        pg.click('[data-act="return"]'); pg.click('[data-act="m-yes"]'); pg.wait_for_selector("text=Semua unit ada di tempat")
        check(True, f"{vp_name}: rental returned")

        # backoffice
        nav("bo"); pg.wait_for_selector(".kpi")
        check("1.237.500" in pg.inner_text("main"), f"{vp_name}: dashboard total")
        shot("06-dash")
        pg.click('[data-act="bo-tab"][data-t="report"]'); pg.wait_for_selector("text=Per layanan")
        shot("07-report")
        with pg.expect_download() as dl: pg.click('[data-act="rep-csv"]')
        csv = open(dl.value.path(), encoding="utf-8-sig").read()
        check(csv.count("\n") >= 4 and "Snorkeling Private 2 Jam" in csv, f"{vp_name}: CSV export ({csv.count(chr(10))} lines)")
        pg.click('[data-act="bo-tab"][data-t="services"]'); pg.click('.li[data-act="svc-edit"][data-id="s3"]')
        pg.fill('form[data-form="svc"] [name="price"]', "20000"); pg.click('form[data-form="svc"] button[type="submit"]')
        pg.wait_for_timeout(200)
        check("Rp 20.000" in pg.inner_text("main"), f"{vp_name}: laundry price edited")
        shot("08-services")
        pg.click('[data-act="bo-tab"][data-t="users"]'); pg.wait_for_selector('[data-act="user-new"]')
        pg.click('[data-act="user-new"]'); pg.fill('[name="full_name"]', "Kasir Dua"); pg.fill('[name="username"]', "kasir2"); pg.fill('[name="password"]', "rahasia123")
        pg.click('form[data-form="user"] button[type="submit"]'); pg.wait_for_timeout(200)
        check("fn:create" in pg.evaluate("window.MOCK_CALLS"), f"{vp_name}: create user calls function")
        shot("09-users")
        pg.click('[data-act="bo-tab"][data-t="store"]'); pg.fill('[name="business_name"]', "PX Gili Trawangan"); pg.click('form[data-form="store"] button[type="submit"]'); pg.wait_for_timeout(200)
        check("PX Gili Trawangan" in pg.inner_text(".top"), f"{vp_name}: store settings saved")

        # settings + shift close
        nav("set"); pg.wait_for_selector("text=Printer struk"); shot("10-settings")
        pg.click('[data-act="pr-test"]'); pg.wait_for_timeout(200)
        nav("shift"); pg.wait_for_selector("#close-cash")
        pg.fill("#close-cash", "1500000"); pg.click('[data-act="shift-close"]'); pg.click('[data-act="m-yes"]')
        pg.wait_for_selector("text=Rekap shift")
        check("62.500" in pg.inner_text(".modal"), f"{vp_name}: shift diff +62.500 -> {pg.inner_text('.modal')[:60]!r}")
        shot("11-shift")
        ctx.close()

    # logged-out login screen
    ctx = b.new_context(viewport={"width": 390, "height": 844}); pg = ctx.new_page()
    pg.route("http://pxpos.test/**", serve); pg.add_init_script("window.MOCK_LOGGED_OUT = true;")
    pg.on("pageerror", lambda e: errors.append(f"[login] {e}"))
    pg.goto("http://pxpos.test/index.html"); pg.wait_for_selector('form[data-form="login"]')
    pg.screenshot(path=f"{OUT}/login.png"); check(True, "login screen renders")
    b.close()

print("\n".join(steps))
print("console errors:", errors or "none")
sys.exit(1 if errors or any(s.startswith("FAIL") for s in steps) else 0)
