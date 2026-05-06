import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings, ThemePreference } from "../../shared/types";
import { fetchSettings, setThemePreference } from "../rpc";

type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "dark",
  setPreference: () => {},
});

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? getSystemTheme() : pref;
}

function applyThemeClass(theme: ResolvedTheme) {
  const el = document.documentElement;
  if (theme === "dark") el.classList.add("dark");
  else el.classList.remove("dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const settings = queryClient.getQueryData<AppSettings>(["settings"]);
    return settings?.themePreference ?? "dark";
  });

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryKey[0] !== "settings")
        return;
      const settings = event.query.state.data as AppSettings | undefined;
      if (settings?.themePreference) {
        setPreferenceState(settings.themePreference);
      }
    });
  }, [queryClient]);

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);
  const resolved: ResolvedTheme =
    preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setSystemTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    applyThemeClass(resolved);
    localStorage.setItem("codictate-theme", preference);
  }, [resolved, preference]);

  const setPreference = useCallback(
    async (pref: ThemePreference) => {
      setPreferenceState(pref);
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, themePreference: pref } : old,
      );
      localStorage.setItem("codictate-theme", pref);
      applyThemeClass(resolve(pref));
      const ok = await setThemePreference(pref);
      if (!ok) {
        const fresh = await fetchSettings();
        queryClient.setQueryData(["settings"], fresh);
      }
    },
    [queryClient],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
