import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { appEvents, type PermissionState } from "./app-events";
import { fetchPermissions, fetchDevices, fetchSettings } from "./rpc";
import type {
  AppStatus,
  DevAppPreviewRoute,
  SettingsPane,
} from "../shared/types";
import { PermissionScreen } from "./components/Permissions/PermissionScreen";
import { ProductOnboardingScreen } from "./components/Onboarding/ProductOnboardingScreen";
import { ReadyScreen } from "./components/Ready/ReadyScreen";
import {
  SettingsScreen,
  type SettingsCategory,
} from "./components/Settings/SettingsScreen";

const DEFAULT_PERMISSIONS: PermissionState = {
  inputMonitoring: false,
  microphone: false,
  accessibility: false,
  documents: false,
};

export default function App() {
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
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<
    SettingsCategory | undefined
  >(undefined);
  const [devPreviewRoute, setDevPreviewRoute] =
    useState<DevAppPreviewRoute | null>(null);

  const isDev = import.meta.env.DEV;

  useEffect(() => {
    return appEvents.on("status", (s) => setStatus(s));
  }, []);

  useEffect(() => {
    return appEvents.on("openSettingsScreen", () => {
      setDevPreviewRoute(null);
      setShowSettings(true);
    });
  }, []);

  const openSettings = useCallback((pane: SettingsPane) => {
    appEvents.emit("openSettings", pane);
  }, []);

  const p = permissions ?? DEFAULT_PERMISSIONS;
  if (!settings) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-codictate-page overflow-hidden">
        <motion.div
          animate={{ opacity: [0.2, 0.5, 0.2] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          className="w-1.5 h-1.5 rounded-full bg-white/20"
        />
      </div>
    );
  }

  const usesMacPermissionFlow = settings.capabilities.supportsMacPermissionFlow;
  const allPermissionsGranted = usesMacPermissionFlow
    ? p.inputMonitoring && p.microphone && p.accessibility && p.documents
    : true;

  const needsProductOnboarding =
    allPermissionsGranted &&
    settings !== undefined &&
    settings.onboardingCompleted === false;

  if (!permissions) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-codictate-page overflow-hidden">
        <motion.div
          animate={{ opacity: [0.2, 0.5, 0.2] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          className="w-1.5 h-1.5 rounded-full bg-white/20"
        />
      </div>
    );
  }

  if (isDev && devPreviewRoute !== null) {
    if (devPreviewRoute === "permissions") {
      return <PermissionScreen permissions={p} onOpenSettings={openSettings} />;
    }
    if (settings) {
      if (devPreviewRoute === "onboarding") {
        return <ProductOnboardingScreen settings={settings} />;
      }
      if (devPreviewRoute === "ready") {
        return (
          <ReadyScreen
            status={status}
            deviceInfo={deviceInfo}
            settings={settings}
            onOpenSettings={(section) => {
              setSettingsInitialCategory(section);
              setShowSettings(true);
            }}
          />
        );
      }
    }
  }

  return (
    <>
      {!allPermissionsGranted ? (
        <PermissionScreen permissions={p} onOpenSettings={openSettings} />
      ) : needsProductOnboarding && settings ? (
        <ProductOnboardingScreen settings={settings} />
      ) : showSettings && settings ? (
        <SettingsScreen
          settings={settings}
          onBack={() => {
            setShowSettings(false);
            setSettingsInitialCategory(undefined);
          }}
          initialCategory={settingsInitialCategory}
          devPreviewRoute={isDev ? devPreviewRoute : undefined}
          onDevPreviewRouteChange={
            isDev
              ? (route) => {
                  setDevPreviewRoute(route);
                  if (route !== null) setShowSettings(false);
                }
              : undefined
          }
        />
      ) : (
        <ReadyScreen
          status={status}
          deviceInfo={deviceInfo}
          settings={settings}
          onOpenSettings={(section) => {
            setSettingsInitialCategory(section);
            setShowSettings(true);
          }}
        />
      )}
    </>
  );
}
