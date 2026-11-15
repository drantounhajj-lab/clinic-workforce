import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clinics } from "./pages/Clinics";
import { Employees } from "./pages/Employees";
import { Kiosks } from "./pages/Kiosks";
import { CreateOrganization, Login } from "./pages/Login";
import { Punches } from "./pages/Punches";
import { Schedule } from "./pages/Schedule";
import { personName, SessionProvider, useSession } from "./session";
import { supabase } from "./supabase";
import "./styles.css";

type Page = "schedule" | "employees" | "clinics" | "kiosks" | "punches";
const PAGES: Page[] = ["schedule", "employees", "clinics", "kiosks", "punches"];

function pageFromHash(): Page {
  const h = window.location.hash.replace("#", "") as Page;
  return PAGES.includes(h) ? h : "schedule";
}

function Shell() {
  const { t, lang, setLang, ready, session, data, noAccount, myRolesEmpty } = useShellState();
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  if (myRolesEmpty) {
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
          {PAGES.map((p) => (
            <a key={p} href={`#${p}`} className={page === p ? "on" : ""} aria-current={page === p ? "page" : undefined}>
              {t.nav[p]}
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
        {page === "employees" && <Employees />}
        {page === "clinics" && <Clinics />}
        {page === "kiosks" && <Kiosks />}
        {page === "punches" && <Punches />}
      </main>
    </div>
  );
}

function useShellState() {
  const s = useSession();
  return { ...s, myRolesEmpty: !!s.data && s.data.myRoles.length === 0 };
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
