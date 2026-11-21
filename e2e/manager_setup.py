"""Owner signs in, creates the organization, two companies, two clinics (address search mocked)."""
import json
from playwright.sync_api import sync_playwright
from helpers import APP, OUT, Watch, login, sql

NOMINATIM = [
    {"lat": "45.4765", "lon": "-75.7013", "display_name": "x", "address": {"house_number": "100", "road": "Rue Principale", "city": "Gatineau", "state": "Québec", "postcode": "J8X 1A1"}},
]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1400, "height": 900})
    ctx.route("https://nominatim.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(NOMINATIM), headers={"access-control-allow-origin": "*"}))
    ctx.route("https://maps.google.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body="<html><body>map</body></html>"))
    page = ctx.new_page()
    w = Watch(page, "setup")
    login(page, "tony@example.com")
    page.wait_for_selector("#org")
    page.fill("#org", "Cliniques Hajj")
    page.fill("#first", "Tony")
    page.fill("#last", "Hajj")
    page.get_by_role("button", name="Créer").click()
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/01-after-org.png")
    w.report()

    page.goto(f"{APP}/#clinics")
    page.wait_for_timeout(800)
    for name, prov in [("Clinique Gatineau inc.", "QC"), ("Clinique Ottawa inc.", "ON")]:
        page.fill("#company-name", name)
        sel = page.locator("#company-province")
        if sel.count():
            sel.select_option(prov)
        page.get_by_role("button", name="Ajouter une société").click()
        page.wait_for_timeout(700)
    page.screenshot(path=f"{OUT}/02-companies.png", full_page=True)
    w.report()

    # Clinic 1: Gatineau, address search
    page.get_by_role("button", name="Ajouter une clinique").click()
    page.wait_for_timeout(300)
    page.select_option("#c-company", label="Clinique Gatineau inc.")
    page.fill("#c-name", "Gatineau")
    page.fill("#c-address", "100 rue Principale Gatineau")
    page.get_by_role("button", name="Trouver sur la carte").click()
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/03-clinic-form.png", full_page=True)
    page.get_by_role("button", name="Enregistrer").first.click()
    page.wait_for_timeout(1000)
    w.report()

    # Clinic 2: Ottawa (ON company)
    page.get_by_role("button", name="Ajouter une clinique").click()
    page.wait_for_timeout(300)
    page.select_option("#c-company", label="Clinique Ottawa inc.")
    page.fill("#c-name", "Ottawa")
    page.select_option("#c-province", "ON")
    page.get_by_role("button", name="Enregistrer").first.click()
    page.wait_for_timeout(1000)
    page.screenshot(path=f"{OUT}/04-clinics.png", full_page=True)
    w.report()
    print(sql("select name, province, address, latitude, longitude from public.locations order by name"))
    b.close()
