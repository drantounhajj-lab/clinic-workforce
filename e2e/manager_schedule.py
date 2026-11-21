"""Schedule: shifts, open shift, coverage rule, cross-company shift, time off, publish, replacement, copy week."""
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, sql, session, rpc

NEXT_MON = "2026-11-23"
gat = sql("select id from public.locations where name = 'Gatineau'")[0]["id"]
ott = sql("select id from public.locations where name = 'Ottawa'")[0]["id"]
co_on = sql("select id from public.companies where legal_name = 'Clinique Ottawa inc.'")[0]["id"]
luc = sql("select id from public.persons where first_name = 'Luc'")[0]["id"]
marie = sql("select id from public.persons where first_name = 'Marie'")[0]["id"]

# Luc also works for the Ontario company, at Ottawa, Monday afternoon (set up directly)
if not sql("select 1 from public.employments where person_id = $1 and company_id = $2", [luc, co_on]):
    e = sql("insert into public.employments (account_id, person_id, company_id) select account_id, $1, $2 from public.companies where id = $2 returning id", [luc, co_on])[0]["id"]
    sql("insert into public.employment_locations (account_id, employment_id, location_id) select account_id, $1, $2 from public.locations where id = $2", [e, ott])
    sql("insert into public.schedule_weeks (account_id, location_id, week_start) select account_id, $1, $2 from public.locations where id = $1 on conflict do nothing", [ott, NEXT_MON])
    sql("""insert into public.shifts (account_id, location_id, week_start, employment_id, starts_at, ends_at, unpaid_break_minutes)
           select account_id, $1, $2, $3, '2026-11-23 17:10-05', '2026-11-23 21:00-05', 0 from public.locations where id = $1""", [ott, NEXT_MON, e])

# Marie has approved vacation on Wednesday (she asks from the app, a manager approves)
m = session("marie@example.com")
st, r = rpc(m["access_token"], "request_time_off", {"p_type": "vacation", "p_start": "2026-11-25", "p_end": "2026-11-25", "p_note": "Rendez-vous"})
print("time off request:", st, r)
t = session("tony@example.com")
print("decide:", rpc(t["access_token"], "decide_time_off", {"p_id": r["id"], "p_approve": True, "p_paid_hours": 8}))

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1500, "height": 950})
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    ctx.route("https://maps.google.com/**", lambda r: r.abort())
    page = ctx.new_page()
    w = Watch(page, "schedule")
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")

    # Coverage rule: 1 receptionist 8:00-17:00 weekdays at Gatineau
    page.goto(f"{APP}/#clinics")
    page.wait_for_timeout(800)
    page.select_option(f"#cov-pos-{gat}", label="Réceptionniste")
    page.get_by_role("button", name="Ajouter", exact=True).first.click()
    page.wait_for_timeout(800)
    print(sql("select min_count, weekdays, start_time, end_time from public.coverage_rules"))
    w.report()

    page.goto(f"{APP}/#schedule")
    page.wait_for_timeout(1000)
    page.select_option("#sched-clinic", label="Gatineau · QC")
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)

    def add_shift(name, day, start, end, brk="30"):
        page.get_by_role("button", name=f"Ajouter un quart · {name} · {day}").click()
        page.wait_for_selector("#s-start")
        page.fill("#s-start", start)
        page.fill("#s-end", end)
        page.fill("#s-break", brk)
        page.get_by_role("button", name="Enregistrer").click()
        page.wait_for_timeout(900)

    add_shift("Marie Tremblay", NEXT_MON, "08:00", "12:00", "0")
    add_shift("Luc Martin", NEXT_MON, "09:00", "17:00")
    add_shift("Marie Tremblay", "2026-11-25", "08:00", "16:00")
    page.get_by_role("button", name=f"Ajouter un quart · Quart ouvert · 2026-11-24").click()
    page.wait_for_selector("#s-start")
    page.fill("#s-start", "13:00")
    page.fill("#s-end", "17:00")
    page.select_option("#s-pos", label="Podiatre")
    page.get_by_role("button", name="Enregistrer").click()
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/10-schedule-draft.png", full_page=True)
    w.report()

    # Publish (errors expected: Marie on vacation Wednesday)
    page.on("dialog", lambda d: d.accept())
    page.get_by_role("button", name="Publier la semaine").click()
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/11-schedule-publish.png", full_page=True)
    print("issues text:", page.locator(".issues, .card").filter(has_text="congé").first.inner_text()[:300] if page.locator("text=congé").count() else "no time-off issue shown")
    w.report()
    b.close()
