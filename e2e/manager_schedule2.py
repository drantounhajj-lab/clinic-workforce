"""Replacement finder, publish, open-shift volunteer, copy week twice."""
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, sql, session, rpc

NEXT_MON = "2026-11-23"
gat = sql("select id from public.locations where name = 'Gatineau'")[0]["id"]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1500, "height": 950})
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())
    w = Watch(page, "schedule2")
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")
    page.goto(f"{APP}/#schedule")
    page.wait_for_timeout(800)
    page.select_option("#sched-clinic", label="Gatineau · QC")
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)

    # Marie's Wednesday shift → replacement finder → choose Luc
    page.locator("button.chip", has_text="08:00–16:00").first.click()
    page.wait_for_selector("#s-start")
    page.wait_for_timeout(300)
    page.locator("details.cover summary").click()
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/12-replacement.png", full_page=True)
    print("candidates:", page.locator(".candidates li").all_inner_texts())
    page.locator(".candidates li", has_text="Luc Martin").get_by_role("button", name="Choisir").click()
    page.get_by_role("button", name="Enregistrer").click()
    page.wait_for_timeout(1200)
    w.report()

    page.get_by_role("button", name="Publier la semaine").click()
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/13-published.png", full_page=True)
    print(sql("select status from public.schedule_weeks where location_id = $1 and week_start = $2", [gat, NEXT_MON]))
    print("notifications:", [(r["title"], r["body"]) for r in sql("select title, body from app.notifications order by created_at")])
    w.report()

    # Luc volunteers for the open shift from the app
    open_id = sql("select id from public.shifts where employment_id is null and location_id = $1", [gat])[0]["id"]
    luc = session("luc@example.com")
    print("claim:", rpc(luc["access_token"], "claim_open_shift", {"p_shift_id": open_id}))
    print("receptionist claim (refused expected):", rpc(session("marie@example.com")["access_token"], "claim_open_shift", {"p_shift_id": open_id}))
    page.reload()
    page.wait_for_timeout(1500)
    page.select_option("#sched-clinic", label="Gatineau · QC")
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)
    page.locator("button.chip", has_text="13:00–17:00").first.click()
    page.wait_for_selector("#s-start")
    page.wait_for_timeout(400)
    print("open shift candidates:", page.locator(".candidates li").all_inner_texts()[:3])
    page.locator(".candidates li", has_text="Luc Martin").get_by_role("button", name="Choisir").click()
    page.get_by_role("button", name="Enregistrer").click()
    page.wait_for_timeout(1200)
    print(sql("select s.response, c.status from public.shifts s left join public.shift_claims c on c.shift_id = s.id where s.id = $1", [open_id]))
    w.report()

    # Copy into the following week, twice
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="Copier la semaine précédente").click()
    page.wait_for_timeout(1500)
    page.get_by_role("button", name="Copier la semaine précédente").click()
    page.wait_for_timeout(1500)
    print("copied:", sql("select count(*) from public.shifts where location_id = $1 and week_start = '2026-11-30'", [gat]))
    page.screenshot(path=f"{OUT}/14-copied.png", full_page=True)
    w.report()
    b.close()
