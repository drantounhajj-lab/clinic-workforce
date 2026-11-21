"""Requests decisions, exchange approval, every page, other roles."""
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, sql

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1500, "height": 950})
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())
    w = Watch(page, "part3")
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")
    page.goto(f"{APP}/#requests")
    page.wait_for_timeout(1500)
    print("after decisions:", sql("select type, status, paid_hours from public.time_off_requests order by created_at"),
          sql("select weekday, status from public.availability_rules order by weekday"))
    w.report()

    page.goto(f"{APP}/#swaps")
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/19-swaps.png", full_page=True)
    if page.get_by_role("button", name="Approuver").count():
        page.get_by_role("button", name="Approuver").first.click()
        page.wait_for_timeout(1200)
    print("swap status:", sql("select status from public.shift_swaps"))
    page.screenshot(path=f"{OUT}/19b-swaps-after.png", full_page=True)
    w.report()

    for pg in ["kiosks", "punches", "schedule", "employees", "roles", "clinics", "timesheets"]:
        page.goto(f"{APP}/#{pg}")
        page.wait_for_timeout(1000)
    w.report()

    for who in ["julie@example.com", "coco@example.com", "marie@example.com"]:
        page.evaluate("localStorage.clear()")
        login(page, who)
        page.wait_for_timeout(1500)
        links = page.locator("nav a").all_inner_texts()
        print(who, "nav:", [l.strip() for l in links])
        for i in range(len(links)):
            page.locator("nav a").nth(i).click()
            page.wait_for_timeout(900)
        page.screenshot(path=f"{OUT}/20-{who.split('@')[0]}.png", full_page=True)
        w.report()
    b.close()
