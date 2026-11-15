import type { Session } from "@supabase/supabase-js";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type Lang, strings, type Strings } from "./i18n";
import {
  type Company,
  type Employment,
  type Location,
  must,
  type Person,
  type RoleAssignment,
  supabase,
} from "./supabase";

export interface AccountData {
  me: Person;
  myRoles: RoleAssignment[];
  companies: Company[];
  locations: Location[];
  persons: Person[];
  roles: RoleAssignment[];
  employments: Employment[];
}

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Strings;
  session: Session | null;
  ready: boolean;
  data: AccountData | null;
  /** True when signed in but not linked to any account yet. */
  noAccount: boolean;
  reload: () => Promise<void>;
  isOwner: boolean;
  managesCompany: (companyId: string) => boolean;
  managesLocation: (locationId: string) => boolean;
  managedLocations: Location[];
}

const SessionContext = createContext<Ctx | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("cw-manager-lang");
    if (saved === "fr" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<AccountData | null>(null);
  const [noAccount, setNoAccount] = useState(false);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("cw-manager-lang", l);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    document.documentElement.lang = lang === "fr" ? "fr-CA" : "en-CA";
  }, [lang]);

  const load = useCallback(async (s: Session | null) => {
    if (!s) {
      setData(null);
      setNoAccount(false);
      return;
    }
    const me = must(await supabase.from("persons").select("*").eq("user_id", s.user.id).maybeSingle()) as Person | null;
    if (!me) {
      setData(null);
      setNoAccount(true);
      return;
    }
    setNoAccount(false);
    const [companies, locations, persons, roles, employments] = await Promise.all([
      supabase.from("companies").select("*").order("legal_name"),
      supabase.from("locations").select("*").order("name"),
      supabase.from("persons").select("*").order("last_name"),
      supabase.from("role_assignments").select("*"),
      supabase.from("employments").select("*, employment_locations(location_id)"),
    ]);
    const allRoles = must(roles) as RoleAssignment[];
    setData({
      me,
      myRoles: allRoles.filter((r) => r.person_id === me.id),
      companies: must(companies) as Company[],
      locations: must(locations) as Location[],
      persons: must(persons) as Person[],
      roles: allRoles,
      employments: must(employments) as Employment[],
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s);
      try {
        await load(s);
      } finally {
        setReady(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") load(s).catch(() => undefined);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const reload = useCallback(() => load(session), [load, session]);

  const myRoles = data?.myRoles ?? [];
  const isOwner = myRoles.some((r) => r.role === "owner");
  const managesCompany = (companyId: string) =>
    isOwner || myRoles.some((r) => r.role === "company_admin" && r.company_id === companyId);
  const managesLocation = (locationId: string) => {
    const loc = data?.locations.find((l) => l.id === locationId);
    if (!loc) return false;
    return managesCompany(loc.company_id) || myRoles.some((r) => r.role === "clinic_manager" && r.location_id === locationId);
  };
  const managedLocations = (data?.locations ?? []).filter((l) => managesLocation(l.id));

  return (
    <SessionContext.Provider
      value={{ lang, setLang, t: strings[lang], session, ready, data, noAccount, reload, isOwner, managesCompany, managesLocation, managedLocations }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside provider");
  return ctx;
}

export function personName(p: Person | undefined): string {
  return p ? `${p.first_name} ${p.last_name}` : "";
}
