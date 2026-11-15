import { useState } from "react";
import { useSession } from "../session";
import { supabase } from "../supabase";

export function Login() {
  const { t } = useSession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setError(t.invalidEmail);
      return;
    }
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithOtp({ email: clean, options: { shouldCreateUser: true } });
    setBusy(false);
    if (err) setError(err.message);
    else {
      setEmail(clean);
      setStep("code");
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t.invalidCode);
      return;
    }
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: "email" });
    setBusy(false);
    if (err) setError(err.message);
  }

  return (
    <div className="center-page">
      <div className="card narrow">
        <h1>{t.signIn}</h1>
        {step === "email" ? (
          <form onSubmit={sendCode} className="stack">
            <label className="field" htmlFor="login-email">
              <span>{t.email}</span>
              <input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" className="primary" disabled={busy}>
              {t.sendCode}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="stack">
            <p className="muted">{t.codeSent(email)}</p>
            <label className="field" htmlFor="login-code">
              <span>{t.code}</span>
              <input
                id="login-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" className="primary" disabled={busy}>
              {t.verify}
            </button>
            <button type="button" className="link" onClick={() => { setStep("email"); setCode(""); setError(""); }}>
              {t.otherEmail}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function CreateOrganization() {
  const { t, reload } = useSession();
  const [org, setOrg] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { data, error: err } = await supabase.rpc("create_account", { p_account_name: org.trim(), p_first_name: first.trim(), p_last_name: last.trim() });
    setBusy(false);
    if (err) setError(err.message);
    else if (!data?.ok) setError(String(data?.reason ?? "error"));
    else await reload();
  }

  return (
    <div className="center-page">
      <form className="card narrow stack" onSubmit={submit}>
        <h1>{t.createOrgTitle}</h1>
        <p className="muted">{t.createOrgHint}</p>
        <label className="field" htmlFor="org">
          <span>{t.orgName}</span>
          <input id="org" value={org} onChange={(e) => setOrg(e.target.value)} required maxLength={200} />
        </label>
        <div className="row">
          <label className="field grow" htmlFor="first">
            <span>{t.firstName}</span>
            <input id="first" value={first} onChange={(e) => setFirst(e.target.value)} required maxLength={100} />
          </label>
          <label className="field grow" htmlFor="last">
            <span>{t.lastName}</span>
            <input id="last" value={last} onChange={(e) => setLast(e.target.value)} required maxLength={100} />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {t.create}
        </button>
      </form>
    </div>
  );
}
