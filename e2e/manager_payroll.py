"""Timesheets (approve, add a missing punch, Excel export), requests, exchanges, other pages, other roles."""
import openpyxl
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, sql, session, rpc, rest

gat = sql("select id from public.locations where name = 'Gatineau'")[0]["id"]
ott = sql("select id from public.locations where name = 'Ottawa'")[0]["id"]
def emp(first, loc):
    return sql("""select e.id, e.person_id, e.account_id from public.employments e join public.persons p on p.id = e.person_id
                  join public.employment_locations el on el.employment_id = e.id where p.first_name = $1 and el.location_id = $2""", [first, loc])[0]

# Punches this pay period (Nov 8–21): Marie 4 days, Luc 5 long days (overtime) with one missing "out"
sql("delete from public.punches")
for first, days, start, end in [("Marie", ["16", "17", "18", "19"], "08:00", "16:30"), ("Luc", ["16", "17", "18", "19", "20"], "07:30", "17:00")]:
    e = emp(first, gat)
    for d in days:
        sql("insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at) values ($1,$2,$3,$4,'in','phone_geofence',$5)",
            [e["account_id"], e["person_id"], e["id"], gat, f"2026-11-{d} {start}-05"])
        if not (first == "Luc" and d == "20"):
            sql("insert into public.punches (account_id, person_id, employment_id, location_id, kind, method, occurred_at) values ($1,$2,$3,$4,'out','phone_geofence',$5)",
                [e["account_id"], e["person_id"], e["id"], gat, f"2026-11-{d} {end}-05"])

# Requests from the app: Luc time off, Marie availability, Omar missed punch
luc = session("luc@example.com")["access_token"]
marie = session("marie@example.com")
omar = session("omar@example.com")["access_token"]
print("time off:", rpc(luc, "request_time_off", {"p_type": "sick", "p_start": "2026-11-26", "p_end": "2026-11-27", "p_note": "Grippe"}))
marie_id = sql("select id from public.persons where first_name = 'Marie'")[0]["id"]
print("availability:", rest(marie["access_token"], "POST", "/availability_rules", [
    {"person_id": marie_id, "weekday": 0, "start_time": "08:00", "end_time": "16:00"},
    {"person_id": marie_id, "weekday": 2, "start_time": "08:00", "end_time": "12:00"}], prefer="return=minimal"))
print("missed punch:", rpc(omar, "request_punch_correction", {"p_location_id": ott, "p_kind": "in", "p_occurred_at": "2026-11-20T13:00:00Z", "p_reason": "Téléphone mort"}))

# Exchange: Marie (receptionist) can't give her shift to Luc (podiatrist); she gives it to Coco, who accepts
mon = sql("select s.id from public.shifts s join public.employments e on e.id = s.employment_id join public.persons p on p.id = e.person_id where p.first_name='Marie' and s.starts_at = '2026-11-23 08:00-05'")[0]["id"]
print("swap to Luc (refused expected):", rpc(marie["access_token"], "request_shift_swap", {"p_shift_id": mon, "p_target_employment_id": emp("Luc", gat)["id"]}))
print("colleagues offered:", [c["first_name"] for c in rpc(marie["access_token"], "swap_candidates", {"p_shift_id": mon})[1]["colleagues"]])
sw = rpc(marie["access_token"], "request_shift_swap", {"p_shift_id": mon, "p_target_employment_id": emp("Coco", gat)["id"]})
print("swap to Coco:", sw)
print("accept:", rpc(session("coco@example.com")["access_token"], "respond_to_swap", {"p_swap_id": sw[1]["id"], "p_accept": True}))

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1500, "height": 950}, accept_downloads=True)
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())
    w = Watch(page, "payroll")
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")
    page.screenshot(path=f"{OUT}/15-nav-badges.png")

    page.goto(f"{APP}/#timesheets")
    page.wait_for_timeout(1200)
    page.select_option("#ts-period", value="2026-11-08")  # the period with the test punches (Nov 16–20)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/16-timesheets.png", full_page=True)
    print("rows:", page.locator("table.table > tbody > tr").all_inner_texts())
    page.get_by_role("button", name="Luc Martin").click()
    page.wait_for_timeout(500)
    page.screenshot(path=f"{OUT}/17-timesheet-detail.png", full_page=True)
    page.get_by_role("button", name="Ajouter la sortie").click()
    page.fill("#ap-time", "17:05")
    page.fill("#ap-note", "Oublié en partant")
    page.get_by_role("button", name="Enregistrer").click()
    page.wait_for_timeout(1500)
    print("rows after fix:", page.locator("table.table > tbody > tr").all_inner_texts()[:3])
    page.get_by_role("button", name="Approuver toutes celles sans problème").click()
    page.wait_for_timeout(1500)
    print("approvals:", sql("select regular_minutes, overtime_minutes from public.timesheet_approvals"))
    with page.expect_download() as dl:
        page.get_by_role("button", name="Exporter vers Excel").click()
    path = f"{OUT}/{dl.value.suggested_filename}"
    dl.value.save_as(path)
    wb = openpyxl.load_workbook(path)
    print("excel:", path.split("/")[-1], wb.sheetnames)
    for row in wb["Résumé"].iter_rows(min_row=4, max_row=8, values_only=True):
        print("   ", row)
    w.report()

    page.goto(f"{APP}/#requests")
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/18-requests.png", full_page=True)
    luc_card = page.locator("article", has_text="Luc Martin")
    print("paid hours placeholder:", luc_card.locator("input[id^=paid-]").get_attribute("placeholder"), "| suggestion:", luc_card.get_by_role("button", name="Utiliser la suggestion").inner_text())
    luc_card.get_by_role("button", name="Utiliser la suggestion").click()
    luc_card.get_by_role("button", name="Approuver").click()
    page.wait_for_timeout(1000)
    page.locator("article", has_text="Marie Tremblay").get_by_role("button", name="Approuver").click()
    page.wait_for_timeout(1000)
    page.locator("article", has_text="Omar Haddad").get_by_role("button", name="Approuver").click()
    page.wait_for_timeout(1000)
    print("after decisions:", sql("select type, status, paid_hours from public.time_off_requests order by created_at"),
          sql("select weekday, status from public.availability_rules order by weekday"),
          sql("select status from public.punch_corrections where reason = 'Téléphone mort'"))
    w.report()

    page.goto(f"{APP}/#swaps")
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/19-swaps.png", full_page=True)
    page.get_by_role("button", name="Approuver").first.click()
    page.wait_for_timeout(1200)
    print("swap status:", sql("select status from public.shift_swaps"))
    w.report()

    for pg in ["kiosks", "punches", "schedule", "employees", "roles", "clinics"]:
        page.goto(f"{APP}/#{pg}")
        page.wait_for_timeout(1000)
    w.report()

    for who in ["julie@example.com", "coco@example.com", "marie@example.com"]:
        page.evaluate("localStorage.clear()")
        login(page, who)
        page.wait_for_timeout(1500)
        links = page.locator("nav a").all_inner_texts()
        print(who, "nav:", links)
        for name in links:
            page.get_by_role("link", name=name).first.click()
            page.wait_for_timeout(900)
        page.screenshot(path=f"{OUT}/20-{who.split('@')[0]}.png", full_page=True)
        w.report()
    b.close()
