"""Shared helpers for the end-to-end checks (Playwright + the local backend in e2e/stack.mjs)."""
import json
import os
import urllib.request

API = "http://localhost:54321"
APP = "http://localhost:5173"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)


def sql(query, params=None):
    req = urllib.request.Request(f"{API}/__test/sql", data=json.dumps({"sql": query, "params": params or []}).encode(), headers={"content-type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read())


def session(email):
    req = urllib.request.Request(f"{API}/__test/session", data=json.dumps({"email": email}).encode(), headers={"content-type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read())


def rest(token, method, path, body=None, prefer=None):
    headers = {"content-type": "application/json", "apikey": "local-anon", "authorization": f"Bearer {token}"}
    if prefer:
        headers["prefer"] = prefer
    req = urllib.request.Request(f"{API}/rest/v1{path}", data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req)
        raw = r.read()
        return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def rpc(token, fn, args):
    return rest(token, "POST", f"/rpc/{fn}", args)


class Watch:
    """Collects browser errors and failed API calls."""

    def __init__(self, page, name):
        self.name = name
        self.problems = []
        page.on("pageerror", lambda e: self.problems.append(f"[pageerror] {e}"))
        page.on("console", lambda m: m.type == "error" and self.problems.append(f"[console] {m.text}"))

        def on_response(r):
            if r.url.startswith(API) and r.status >= 400:
                try:
                    body = r.text()[:300]
                except Exception:
                    body = ""
                self.problems.append(f"[api {r.status}] {r.request.method} {r.url.replace(API, '')[:160]} → {body}")

        page.on("response", on_response)

    def report(self):
        print(f"--- {self.name}: {len(self.problems)} problem(s)")
        for p in self.problems:
            print("   ", p)
        self.problems.clear()


def login(page, email):
    page.goto(APP)
    page.fill("#login-email", email)
    page.get_by_role("button", name="M'envoyer un code").click()
    page.fill("#login-code", "123456")
    page.get_by_role("button", name="Se connecter").click()
