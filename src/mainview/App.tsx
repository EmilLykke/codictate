import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { appEvents, type PermissionState } from "./app-events";
import {
  fetchPermissions,
  fetchDevices,
  fetchSettings,
  fetchOnboardingState,
  completeOnboarding,
} from "./rpc";
import type { AppStatus, SettingsPane, ShortcutId } from "../shared/types";
import { PermissionScreen } from "./components/Permissions/PermissionScreen";
import { ReadyScreen } from "./components/Ready/ReadyScreen";
import { SettingsScreen } from "./components/Settings/SettingsScreen";
import { TryItStep } from "./components/Onboarding/TryItStep";

const DEFAULT_PERMISSIONS: PermissionState = {
  inputMonitoring: false,
  microphone: false,
  accessibility: false,
  documents: false,
};

export default function App() {
  const queryClient = useQueryClient();

  const { data: onboardingState } = useQuery({
    queryKey: ["onboarding"],
    queryFn: fetchOnboardingState,
    staleTime: Infinity,
  });

  const { data: permissions } = useQuery({
    queryKey: ["permissions"],
    queryFn: fetchPermissions,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (
        d?.inputMonitoring &&
        d?.microphone &&
        d?.accessibility &&
        d?.documents
      )
        return false;
      return 3000;
    },
    refetchOnWindowFocus: true,
    staleTime: 1000,
  });

  const { data: deviceInfo } = useQuery({
    queryKey: ["devices"],
    queryFn: fetchDevices,
    staleTime: Infinity,
  });

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    staleTime: Infinity,
  });

  const [status, setStatus] = useState<AppStatus>("ready");
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    return appEvents.on("status", (s) => setStatus(s));
  }, []);

  useEffect(() => {
    return appEvents.on("openSettingsScreen", () => setShowSettings(true));
  }, []);

  const openSettings = useCallback((pane: SettingsPane) => {
    appEvents.emit("openSettings", pane);
  }, []);

  const handleOnboardingComplete = useCallback(async () => {
    await completeOnboarding();
    queryClient.setQueryData(["onboarding"], { hasCompleted: true });
  }, [queryClient]);

  const p = permissions ?? DEFAULT_PERMISSIONS;
  const allPermissionsGranted =
    p.inputMonitoring && p.microphone && p.accessibility && p.documents;

  if (!permissions || !onboardingState) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-codictate-page">
        <motion.div
          animate={{ opacity: [0.2, 0.5, 0.2] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          className="w-1.5 h-1.5 rounded-full bg-white/20"
        />
      </div>
    );
  }

  // Permissions not yet all granted — show the permission checklist screen
  if (!allPermissionsGranted) {
    return <PermissionScreen permissions={p} onOpenSettings={openSettings} />;
  }

  // All permissions granted but onboarding not completed — show "try it" screen
  if (!onboardingState.hasCompleted) {
    const shortcutId: ShortcutId = settings?.shortcutId ?? "option-space";
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-codictate-page text-white select-none px-6">
        <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 h-7" />
        <div className="w-full max-w-[460px]">
          <TryItStep
            shortcutId={shortcutId}
            onDone={handleOnboardingComplete}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {showSettings && settings ? (
        <SettingsScreen
          settings={settings}
          onBack={() => setShowSettings(false)}
        />
      ) : (
        <ReadyScreen
          status={status}
          deviceInfo={deviceInfo}
          settings={settings}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
    </>
  );
}
