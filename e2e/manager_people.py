"""Positions and roles, employees (incl. the owner's own row), credentials."""
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, sql

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1400, "height": 900})
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page = ctx.new_page()
    w = Watch(page, "people")
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")

    # Positions
    page.goto(f"{APP}/#roles")
    for fr, en in [("Réceptionniste", "Receptionist"), ("Podiatre", "Podiatrist")]:
        page.fill("#pos-fr", fr)
        page.fill("#pos-en", en)
        page.get_by_role("button", name="Ajouter un poste").click()
        page.wait_for_timeout(600)
    # Same name again (different case): refused with a readable message
    page.fill("#pos-fr", " podiatre ")
    page.fill("#pos-en", "Foot doctor")
    page.get_by_role("button", name="Ajouter un poste").click()
    page.wait_for_timeout(600)
    print("duplicate position:", page.locator(".error").all_inner_texts(), "| positions:", [r["name_fr"] for r in sql("select name_fr from public.job_roles order by 1")])
    w.problems = [x for x in w.problems if "409" not in x and "duplicate" not in x.lower()]
    # Custom role
    page.fill("#role-name", "Coordonnatrice")
    page.select_option("#role-company", label="Clinique Gatineau inc.")
    page.check("#new-perm-schedule")
    page.get_by_role("button", name="Ajouter un rôle").click()
    page.wait_for_timeout(800)
    # Same role name again
    page.fill("#role-name", "Coordonnatrice")
    page.select_option("#role-company", label="Clinique Gatineau inc.")
    page.get_by_role("button", name="Ajouter un rôle").click()
    page.wait_for_timeout(600)
    print("duplicate role:", page.locator(".error").all_inner_texts())
    w.problems = [x for x in w.problems if "409" not in x and "duplicate" not in x.lower()]
    # toggle a permission on the existing role
    rid = sql("select id from public.custom_roles limit 1")[0]["id"]
    page.click(f"#perm-{rid}-punches")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/05-roles.png", full_page=True)
    print(sql("select name, permissions from public.custom_roles"))
    w.report()

    # Owner's own row
    page.goto(f"{APP}/#employees")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/06-employees-before.png", full_page=True)
    page.get_by_role("button", name="Modifier").first.click()
    page.wait_for_timeout(500)
    page.select_option("#e-company", label="Clinique Gatineau inc.")
    page.wait_for_timeout(200)
    gat = sql("select id from public.locations where name = 'Gatineau'")[0]["id"]
    ott = sql("select id from public.locations where name = 'Ottawa'")[0]["id"]
    page.check(f"#e-loc-{gat}")
    page.select_option("#e-position", label="Podiatre")
    page.fill("#e-payroll", "1001")
    page.get_by_role("button", name="Enregistrer").first.click()
    page.wait_for_timeout(1000)
    w.report()

    def add(first, last, email, company, locs, role=None, position=None, payroll=None, desired=None):
        page.get_by_role("button", name="Ajouter un employé").click()
        page.wait_for_timeout(300)
        page.fill("#e-first", first)
        page.fill("#e-last", last)
        page.fill("#e-email", email)
        page.select_option("#e-company", label=company)
        page.wait_for_timeout(200)
        for l in locs:
            page.check(f"#e-loc-{l}")
        if role:
            page.select_option("#e-role", label=role)
        if position:
            page.select_option("#e-position", label=position)
        if payroll:
            page.fill("#e-payroll", payroll)
        if desired:
            page.fill("#e-desired", desired)
        page.get_by_role("button", name="Enregistrer").first.click()
        page.wait_for_timeout(1000)

    add("Marie", "Tremblay", "marie@example.com", "Clinique Gatineau inc.", [gat], position="Réceptionniste", payroll="1042", desired="32")
    add("Luc", "Martin", "luc@example.com", "Clinique Gatineau inc.", [gat], position="Podiatre", payroll="1043")
    add("Julie", "Roy", "julie@example.com", "Clinique Gatineau inc.", [gat], role="Gestionnaire de clinique")
    add("Coco", "Bélanger", "coco@example.com", "Clinique Gatineau inc.", [gat], role="Coordonnatrice")
    add("Omar", "Haddad", "omar@example.com", "Clinique Ottawa inc.", [ott], payroll="2001")
    page.screenshot(path=f"{OUT}/07-employees.png", full_page=True)
    w.report()
    print(sql("""select p.first_name, e.payroll_number, j.name_fr as position, array_agg(l.name) as clinics
                 from public.persons p left join public.employments e on e.person_id = p.id
                 left join public.job_roles j on j.id = e.job_role_id
                 left join public.employment_locations el on el.employment_id = e.id left join public.locations l on l.id = el.location_id
                 group by 1,2,3 order by 1"""))
    print(sql("select p.first_name, r.role from public.role_assignments r join public.persons p on p.id = r.person_id order by 1"))
    print(sql("select p.first_name, c.name from public.custom_role_assignments a join public.persons p on p.id = a.person_id join public.custom_roles c on c.id = a.custom_role_id"))

    # Credentials on Marie
    page.get_by_role("row", name="Marie").get_by_role("button", name="Modifier").click()
    page.wait_for_timeout(600)
    page.fill("#cr-name", "RCR")
    page.fill("#cr-exp", "2026-12-10")
    page.get_by_role("button", name="Ajouter", exact=True).click()
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/08-credentials.png", full_page=True)
    page.get_by_role("button", name="Annuler").click()
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/09-employees-expiring.png")
    print(sql("select name, expires_on from public.credentials"))
    w.report()
    b.close()
