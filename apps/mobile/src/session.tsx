/**
 * Login state and the signed-in person's data (clinics, roles), loaded from Supabase.
 * A clinic iPad signs in anonymously and is recognized as a kiosk once a manager pairs it.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { getLocales } from "expo-localization";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type Lang, strings, type Strings } from "./i18n";
import { type Employment, type Location, type Person, type RoleAssignment, supabase } from "./supabase";

export interface KioskInfo {
  kiosk_id: string;
  location_id: string;
  location_name: string;
  province: string;
  timezone: string;
}

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Strings;
  ready: boolean;
  session: Session | null;
  isAnonymous: boolean;
  me: Person | null;
  employments: Employment[];
  locations: Location[];
  roles: RoleAssignment[];
  kiosk: KioskInfo | null;
  reload: () => Promise<void>;
  managesLocation: (l: Location) => boolean;
}

const SessionContext = createContext<Ctx | null>(null);
const LANG_KEY = "cw-lang";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getLocales()[0]?.languageCode === "fr" ? "fr" : "en");
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Person | null>(null);
  const [employments, setEmployments] = useState<Employment[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [kiosk, setKiosk] = useState<KioskInfo | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LANG_KEY)
      .then((v) => {
        if (v === "fr" || v === "en") setLangState(v);
      })
      .catch(() => undefined);
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    AsyncStorage.setItem(LANG_KEY, l).catch(() => undefined);
  };

  const load = useCallback(async (s: Session | null) => {
    setMe(null);
    setEmployments([]);
    setLocations([]);
    setRoles([]);
    setKiosk(null);
    if (!s) return;
    if (s.user.is_anonymous) {
      const { data } = await supabase.rpc("kiosk_me");
      setKiosk((data as KioskInfo | null) ?? null);
      return;
    }
    const { data: person } = await supabase.from("persons").select("id, account_id, first_name, last_name, email").eq("user_id", s.user.id).maybeSingle();
    if (!person) return;
    setMe(person as Person);
    const [emps, locs, rls] = await Promise.all([
      supabase.from("employments").select("id, company_id, employment_locations(location_id)").eq("person_id", person.id),
      supabase.from("locations").select("id, company_id, name, province, timezone, latitude, longitude, geofence_radius_m, early_punch_limit_min").order("name"),
      supabase.from("role_assignments").select("role, company_id, location_id").eq("person_id", person.id),
    ]);
    setEmployments((emps.data as Employment[]) ?? []);
    setLocations((locs.data as Location[]) ?? []);
    setRoles((rls.data as RoleAssignment[]) ?? []);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      try {
        await load(data.session);
      } finally {
        setReady(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") load(s).catch(() => undefined);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const reload = useCallback(() => load(session), [load, session]);

  const managesLocation = (l: Location) =>
    roles.some(
      (r) => r.role === "owner" || (r.role === "company_admin" && r.company_id === l.company_id) || (r.role === "clinic_manager" && r.location_id === l.id),
    );

  return (
    <SessionContext.Provider
      value={{
        lang,
        setLang,
        t: strings[lang],
        ready,
        session,
        isAnonymous: !!session?.user.is_anonymous,
        me,
        employments,
        locations,
        roles,
        kiosk,
        reload,
        managesLocation,
      }}
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

/** Clinics where the signed-in person works. */
export function useMyClinics(): Location[] {
  const { employments, locations } = useSession();
  const ids = new Set(employments.flatMap((e) => e.employment_locations.map((x) => x.location_id)));
  return locations.filter((l) => ids.has(l.id));
}
