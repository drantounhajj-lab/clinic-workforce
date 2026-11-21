"""Wrong code, a stranger's first sign-in, English, iPad pairing from the page, punches view."""
import json, urllib.request
from playwright.sync_api import sync_playwright
from helpers import API, APP, OUT, Watch, login, sql

def anon_pairing():
    req = urllib.request.Request(f"{API}/auth/v1/signup", data=b"{}", headers={"content-type": "application/json"}, method="POST")
    s = json.loads(urllib.request.urlopen(req).read())
    req = urllib.request.Request(f"{API}/rest/v1/rpc/kiosk_request_pairing", data=b"{}", headers={"content-type": "application/json", "authorization": f"Bearer {s['access_token']}", "apikey": "x"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read())

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    ctx = b.new_context(locale="fr-CA", viewport={"width": 1400, "height": 900})
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page = ctx.new_page()
    w = Watch(page, "misc")
    page.goto(APP)
    page.fill("#login-email", "tony@example.com")
    page.get_by_role("button", name="M'envoyer un code").click()
    page.fill("#login-code", "999999")
    page.get_by_role("button", name="Se connecter").click()
    page.wait_for_timeout(800)
    print("wrong code message:", page.locator(".error").all_inner_texts())
    w.problems = [x for x in w.problems if "verify" not in x and "403" not in x]
    w.report()

    page.evaluate("localStorage.clear()")
    login(page, "stranger@example.com")
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{OUT}/21-stranger.png", full_page=True)
    print("stranger sees:", page.locator("main, body").first.inner_text()[:200].replace("\n", " | "))
    w.report()

    page.evaluate("localStorage.clear()")
    login(page, "tony@example.com")
    page.wait_for_selector("nav a")
    page.get_by_role("button", name="EN", exact=True).click()
    page.wait_for_timeout(500)
    for pg in ["schedule", "swaps", "requests", "timesheets", "employees", "roles", "clinics", "kiosks", "punches"]:
        page.goto(f"{APP}/#{pg}")
        page.wait_for_timeout(700)
    page.screenshot(path=f"{OUT}/22-en-punches.png", full_page=True)
    w.report()

    code = anon_pairing()["code"]
    page.goto(f"{APP}/#kiosks")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/23-kiosks.png", full_page=True)
    inputs = page.locator("input")
    print("kiosk inputs:", [inputs.nth(i).get_attribute("id") for i in range(inputs.count())])
    w.report()
    b.close()
