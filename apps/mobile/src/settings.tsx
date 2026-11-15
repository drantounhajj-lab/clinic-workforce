/**
 * Device settings and local test data, saved with AsyncStorage.
 * Until the backend exists, everything here stays on this device.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type Lang, strings, type Strings } from "./i18n";

export interface ClinicOverride {
  latitude?: number;
  longitude?: number;
  radiusM?: number;
  wifiBssids?: string[];
  wifiNames?: string[];
}

export interface StoredPunch {
  id: string;
  personId: string;
  kind: "in" | "out";
  at: string; // ISO
  clinicId: string;
  method: "gps" | "qr" | "kiosk";
  flags: string[];
  distanceM?: number;
}

export interface Settings {
  lang: Lang;
  personId: string | null;
  ignoreSchedule: boolean;
  clinicOverrides: Record<string, ClinicOverride>;
  punches: StoredPunch[];
}

const KEY = "clinic-workforce-settings-v1";

const defaults = (): Settings => ({
  lang: getLocales()[0]?.languageCode === "fr" ? "fr" : "en",
  personId: null,
  ignoreSchedule: true,
  clinicOverrides: {},
  punches: [],
});

interface Ctx {
  settings: Settings;
  t: Strings;
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
  setOverride: (clinicId: string, patch: ClinicOverride | null) => void;
  addPunch: (p: Omit<StoredPunch, "id">) => void;
}

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) setSettings({ ...defaults(), ...(JSON.parse(raw) as Partial<Settings>) });
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready) AsyncStorage.setItem(KEY, JSON.stringify(settings)).catch(() => undefined);
  }, [settings, ready]);

  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);

  const setOverride = useCallback((clinicId: string, patch: ClinicOverride | null) => {
    setSettings((s) => {
      const clinicOverrides = { ...s.clinicOverrides };
      if (patch === null) delete clinicOverrides[clinicId];
      else clinicOverrides[clinicId] = { ...clinicOverrides[clinicId], ...patch };
      return { ...s, clinicOverrides };
    });
  }, []);

  const addPunch = useCallback((p: Omit<StoredPunch, "id">) => {
    setSettings((s) => ({ ...s, punches: [...s.punches, { ...p, id: `${Date.now()}-${s.punches.length}` }].slice(-200) }));
  }, []);

  const value = useMemo(
    () => ({ settings, t: strings[settings.lang], ready, update, setOverride, addPunch }),
    [settings, ready, update, setOverride, addPunch],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}
