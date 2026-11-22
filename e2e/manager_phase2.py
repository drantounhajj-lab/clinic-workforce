"""Phase 2 through the manager page: acceptance test 1 (Friday afternoon off → cover found), leave types,
all-clinics page and reminders, templates, recurring shifts, staffing ratios. Run after the other scripts."""
import datetime as dt
import threading
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, rpc, session, sql

acct = sql("select id from public.accounts limit 1")[0]["id"]
co = sql("select id from public.companies where legal_name = 'Clinique Gatineau inc.'")[0]["id"]
today = dt.date.today()
next_monday = today + dt.timedelta(days=7 - today.weekday())
W = next_monday.isoformat()
fri = (next_monday + dt.timedelta(days=4)).isoformat()

# Aylmer clinic, assistants Ava, Bea, Cal; one assistant needed 08:00–17:00 on weekdays
ayl = sql("insert into public.locations (account_id, company_id, name, province, address, latitude, longitude) values ($1, $2, 'Aylmer', 'QC', '1 rue Principale, Gatineau (Aylmer)', 45.397, -75.84) returning id", [acct, co])[0]["id"]
asst = sql("insert into public.job_roles (account_id, name_fr, name_en) values ($1, 'Assistante', 'Assistant') returning id", [acct])[0]["id"]
emp = {}
for first in ["Ava", "Bea", "Cal"]:
    pid = sql("insert into public.persons (account_id, first_name, last_name, email) values ($1, $2, 'Lefebvre', $3) returning id", [acct, first, f"{first.lower()}@example.com"])[0]["id"]
    eid = sql("insert into public.employments (account_id, person_id, company_id, job_role_id) values ($1, $2, $3, $4) returning id", [acct, pid, co, asst])[0]["id"]
    sql("insert into public.employment_locations (account_id, employment_id, location_id) values ($1, $2, $3)", [acct, eid, ayl])
    emp[first] = eid
sql("insert into public.coverage_rules (account_id, location_id, job_role_id, weekdays, start_time, end_time, min_count) values ($1, $2, $3, '{0,1,2,3,4}', '08:00', '17:00', 1)", [acct, ayl, asst])
sql("insert into public.schedule_weeks (account_id, location_id, week_start, status, published_at) values ($1, $2, $3, 'published', now())", [acct, ayl, W])
def shift(e, day, a, b):
    d = (next_monday + dt.timedelta(days=day)).isoformat()
    return sql("insert into public.shifts (account_id, location_id, week_start, employment_id, starts_at, ends_at) values ($1, $2, $3, $4, ($5::date + $6::time) at time zone 'America/Toronto', ($5::date + $7::time) at time zone 'America/Toronto') returning id", [acct, ayl, W, e, d, a, b])[0]["id"]
for day in range(5):
    if day != 4:
        shift(emp["Ava"], day, "08:00", "17:00")
friday = shift(emp["Ava"], 4, "13:00", "17:00")
shift(emp["Bea"], 4, "08:00", "13:00")
shift(emp["Cal"], 3, "08:00", "12:00")

tokens = {n: session(f"{n.lower()}@example.com")["access_token"] for n in ["Ava", "Bea", "Cal"]}
types = rpc(tokens["Ava"], "my_offers", {})  # warm-up: links the logins
lt = {r["name_fr"]: r["id"] for r in sql("select id, name_fr from public.leave_types where account_id = $1", [acct])}
print("leave request:", rpc(tokens["Ava"], "request_leave", {"p_leave_type_id": lt["Personnel"], "p_start": fri, "p_end": fri, "p_start_time": "12:30", "p_end_time": "17:00", "p_reason": "Rendez-vous chez le dentiste"}))

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1400, "height": 950})
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    ctx.route("https://*.tile.openstreetmap.org/**", lambda r: r.abort())
    page = ctx.new_page()
    w = Watch(page, "phase2")
    page.on("console", lambda m: m.type == "error" and print("   console:", m.text[:200]))
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")

    # 1. The manager sees the request, the private reason and the coverage gap, then approves
    page.goto(f"{APP}/#requests")
    page.wait_for_timeout(1800)
    card = page.locator("article", has_text="Ava Lefebvre")
    print("request card:", card.inner_text().replace("\n", " | ")[:420])
    page.screenshot(path=f"{OUT}/30-leave-request.png", full_page=True)
    card.get_by_role("button", name="Approuver").click()
    page.wait_for_timeout(1500)
    print("after approval:", page.locator(".notice-card").inner_text().replace("\n", " | ")[:300])
    page.get_by_role("button", name="Offrir aux personnes admissibles").click()
    page.wait_for_timeout(1200)
    print("offer result:", page.locator(".notice-card .notice").all_inner_texts())
    page.screenshot(path=f"{OUT}/31-offered.png", full_page=True)
    w.report()

    # 2. Bea and Cal accept at the same moment
    offer = sql("select id from public.coverage_offers where shift_id = $1", [friday])[0]["id"]
    answers = {}
    def accept(n):
        answers[n] = rpc(tokens[n], "respond_to_offer", {"p_offer_id": offer, "p_accept": True})[1]
    threads = [threading.Thread(target=accept, args=(n,)) for n in ["Bea", "Cal"]]
    for t in threads: t.start()
    for t in threads: t.join()
    print("answers:", answers)
    owner = sql("select p.first_name, s.response from public.shifts s join public.employments e on e.id = s.employment_id join public.persons p on p.id = e.person_id where s.id = $1", [friday])
    print("Friday 13–17 now:", owner)
    print("pushes:", sql("select p.first_name, n.title from app.notifications n join public.persons p on p.id = n.person_id where n.title in ('Quart offert','Quart déjà pourvu','Remplacement trouvé','Congé approuvé','Quart retiré','Nouveau quart') and p.first_name in ('Ava','Bea','Cal','Antoun') order by n.created_at"))

    # 3. Schedule at Aylmer shows the new owner; the all-clinics page and reminders
    page.goto(f"{APP}/#schedule")
    page.wait_for_timeout(800)
    page.select_option("#sched-clinic", label="Aylmer · QC")
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/32-aylmer-schedule.png", full_page=True)
    page.goto(f"{APP}/#overview")
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)
    page.select_option("#ov-clinic", label="Aylmer")
    page.wait_for_timeout(500)
    print("overview rows:", [r.replace("\n", " | ")[:120] for r in page.locator("table.overview tbody tr").all_inner_texts()][:4])
    pending_before = page.locator("section", has_text="Pas encore vus").locator("li").count()
    page.get_by_role("button", name="Relancer tout le monde").click()
    page.wait_for_timeout(1000)
    print("unacknowledged:", pending_before, "|", page.locator("section", has_text="Pas encore vus").locator(".notice").all_inner_texts())
    page.screenshot(path=f"{OUT}/33-overview.png", full_page=True)
    w.report()

    # 4. Templates: save next week, apply to the 2 weeks after
    page.goto(f"{APP}/#schedule")
    page.wait_for_timeout(800)
    page.select_option("#sched-clinic", label="Aylmer · QC")
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="Modèles").click()
    page.fill("#tpl-name", "Semaine type Aylmer")
    page.get_by_role("button", name="Enregistrer comme modèle").last.click()
    page.wait_for_timeout(1000)
    page.get_by_role("button", name="Fermer").click()
    page.get_by_role("button", name="Semaine suivante").click()
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="Modèles").click()
    page.fill("#tpl-count", "2")
    page.locator("button", has_text="Appliquer un modèle").click()
    page.wait_for_timeout(1200)
    print("template toast:", page.locator(".toast").inner_text())
    page.locator("button", has_text="Appliquer un modèle").click()
    page.wait_for_timeout(1200)
    print("again:", page.locator(".toast").inner_text())
    page.get_by_role("button", name="Fermer").click()
    w.report()

    # 5. Recurring shift: Cal every week for 4 weeks
    page.locator("button.add").first.click()
    page.select_option("#s-emp", label="Cal Lefebvre")
    page.fill("#s-start", "14:00")
    page.fill("#s-end", "18:00")
    page.select_option("#s-repeat", value="1")
    until = (next_monday + dt.timedelta(days=7 + 21)).isoformat()
    page.fill("#s-until", until)
    page.get_by_role("button", name="Enregistrer").click()
    page.wait_for_timeout(1200)
    print("recurring toast:", page.locator(".toast").inner_text())
    w.report()

    # 6. Staffing ratio at Gatineau, leave type "Formation"
    page.goto(f"{APP}/#clinics")
    page.wait_for_timeout(1000)
    sect = page.locator("form", has=page.get_by_role("button", name="Ajouter le ratio")).first
    sect.locator("select").nth(0).select_option(label="Podiatre")
    sect.locator("select").nth(1).select_option(label="Réceptionniste")
    sect.get_by_role("button", name="Ajouter le ratio").click()
    page.wait_for_timeout(800)
    print("ratios:", sql("select trigger_count, required_count from public.staffing_ratio_rules"))
    page.goto(f"{APP}/#requests")
    page.wait_for_timeout(1000)
    page.fill("#lt-fr", "Formation")
    page.fill("#lt-en", "Training")
    page.get_by_role("button", name="Ajouter", exact=True).click()
    page.wait_for_timeout(800)
    print("leave types:", [r["name_fr"] for r in sql("select name_fr from public.leave_types where active order by sort")])
    page.screenshot(path=f"{OUT}/34-leave-types.png", full_page=True)
    w.report()
    b.close()
