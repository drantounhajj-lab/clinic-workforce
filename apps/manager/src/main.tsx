import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clinics } from "./pages/Clinics";
import { Employees } from "./pages/Employees";
import { Kiosks } from "./pages/Kiosks";
import { CreateOrganization, Login } from "./pages/Login";
import { Punches } from "./pages/Punches";
import { Requests } from "./pages/Requests";
import { Timesheets } from "./pages/Timesheets";
import { Roles } from "./pages/Roles";
import { Overview } from "./pages/Overview";
import { Schedule } from "./pages/Schedule";
import { Swaps } from "./pages/Swaps";
import { personName, SessionProvider, useSession } from "./session";
import { type Permission, supabase } from "./supabase";
import "./styles.css";

type Page = "schedule" | "overview" | "swaps" | "requests" | "timesheets" | "employees" | "roles" | "clinics" | "kiosks" | "punches";
const PAGES: Page[] = ["schedule", "overview", "swaps", "requests", "timesheets", "employees", "roles", "clinics", "kiosks", "punches"];

function pageFromHash(): Page | null {
  const h = window.location.hash.replace("#", "") as Page;
  return PAGES.includes(h) ? h : null;
}

function Shell() {
  const { t, lang, setLang, ready, session, data, noAccount, visiblePages } = useShellState();
  const [hashPage, setHashPage] = useState<Page | null>(pageFromHash);
  const [pendingSwaps, setPendingSwaps] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);

  useEffect(() => {
    const onHash = () => setHashPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const canSwaps = visiblePages.includes("swaps");
  const countSwaps = useCallback(async () => {
    const { count } = await supabase.from("shift_swaps").select("id", { count: "exact", head: true }).eq("status", "pending_manager");
    setPendingSwaps(count ?? 0);
  }, []);
  useEffect(() => {
    if (!canSwaps) return;
    countSwaps();
    const timer = window.setInterval(countSwaps, 60_000);
    return () => window.clearInterval(timer);
  }, [canSwaps, countSwaps]);

  const canRequests = visiblePages.includes("requests");
  const countRequests = useCallback(async () => {
    const [a, b, c, d] = await Promise.all([
      supabase.from("time_off_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("availability_rules").select("person_id").eq("status", "pending"),
      supabase.from("punch_corrections").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("availability_exceptions").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);
    const people = new Set(((b.data as { person_id: string }[]) ?? []).map((x) => x.person_id)).size;
    setPendingRequests((a.count ?? 0) + people + (c.count ?? 0) + (d.count ?? 0));
  }, []);
  useEffect(() => {
    if (!canRequests) return;
    countRequests();
    const timer = window.setInterval(countRequests, 60_000);
    return () => window.clearInterval(timer);
  }, [canRequests, countRequests]);

  const page: Page | undefined = hashPage && visiblePages.includes(hashPage) ? hashPage : visiblePages[0];

  const langToggle = (
    <div className="lang" role="group" aria-label="Language">
      {(["fr", "en"] as const).map((l) => (
        <button key={l} type="button" className={lang === l ? "on" : ""} aria-pressed={lang === l} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );

  if (!ready) return <p className="center-page muted">{t.loading}</p>;

  if (!session) {
    return (
      <>
        <header className="topbar">
          <Brand t={t} />
          {langToggle}
        </header>
        <Login />
      </>
    );
  }

  const signOut = (
    <button type="button" className="link" onClick={() => supabase.auth.signOut()}>
      {t.signOut}
    </button>
  );

  if (noAccount) {
    return (
      <>
        <header className="topbar">
          <Brand t={t} />
          <div className="row">
            {langToggle}
            {signOut}
          </div>
        </header>
        <CreateOrganization />
      </>
    );
  }

  if (!data) return <p className="center-page muted">{t.loading}</p>;

  if (visiblePages.length === 0 || !page) {
    return (
      <>
        <header className="topbar">
          <Brand t={t} />
          <div className="row">
            {langToggle}
            {signOut}
          </div>
        </header>
        <div className="center-page">
          <div className="card narrow stack">
            <h1>{t.notManagerTitle}</h1>
            <p className="muted">{t.notManagerHint}</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <Brand t={t} />
        <nav className="nav" aria-label="Main">
          {visiblePages.map((p) => (
            <a key={p} href={`#${p}`} className={page === p ? "on" : ""} aria-current={page === p ? "page" : undefined}>
              {t.nav[p]}
              {p === "swaps" && pendingSwaps > 0 && <span className="badge">{pendingSwaps}</span>}
              {p === "requests" && pendingRequests > 0 && <span className="badge">{pendingRequests}</span>}
            </a>
          ))}
        </nav>
        <div className="row">
          <span className="muted small">{personName(data.me)}</span>
          {langToggle}
          {signOut}
        </div>
      </header>
      <main>
        {page === "schedule" && <Schedule />}
        {page === "overview" && <Overview />}
        {page === "swaps" && <Swaps onChange={countSwaps} />}
        {page === "requests" && <Requests onChange={countRequests} />}
        {page === "timesheets" && <Timesheets />}
        {page === "employees" && <Employees />}
        {page === "roles" && <Roles />}
        {page === "clinics" && <Clinics />}
        {page === "kiosks" && <Kiosks />}
        {page === "punches" && <Punches />}
      </main>
    </div>
  );
}

function useShellState() {
  const s = useSession();
  const has = (perm: Permission) => s.locationsWith(perm).length > 0;
  const allowed: Record<Page, boolean> = {
    schedule: has("schedule"),
    overview: has("schedule"),
    swaps: has("schedule"),
    requests: has("schedule") || has("employees") || has("punches"),
    timesheets: has("punches"),
    employees: has("employees") || s.isOwner,
    roles: s.isFullManager,
    clinics: has("clinics") || has("schedule") || (s.data?.companies ?? []).some((c) => s.managesCompany(c.id)) || s.isOwner,
    kiosks: has("kiosks"),
    punches: has("punches"),
  };
  return { ...s, visiblePages: s.data ? PAGES.filter((p) => allowed[p]) : [] };
}

function Brand({ t }: { t: { appName: string; managerArea: string } }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true" />
      <strong>{t.appName}</strong>
      <span className="muted small">{t.managerArea}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <SessionProvider>
    <Shell />
  </SessionProvider>,
);
