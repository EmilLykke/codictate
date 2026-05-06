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
import { MainContainer } from "./components/MainContainer";

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
  const [devPreviewRoute, setDevPreviewRoute] =
    useState<DevAppPreviewRoute | null>(null);

  const isDev = import.meta.env.DEV;

  useEffect(() => {
    return appEvents.on("status", (s) => setStatus(s));
  }, []);

  useEffect(() => {
    return appEvents.on("openSettingsScreen", () => {
      setDevPreviewRoute(null);
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
          className="w-1.5 h-1.5 rounded-full bg-surface-4"
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
          className="w-1.5 h-1.5 rounded-full bg-surface-4"
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
          <MainContainer
            status={status}
            deviceInfo={deviceInfo}
            settings={settings}
            devPreviewRoute={devPreviewRoute}
            onDevPreviewRouteChange={setDevPreviewRoute}
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
      ) : settings ? (
        <MainContainer
          status={status}
          deviceInfo={deviceInfo}
          settings={settings}
          devPreviewRoute={isDev ? devPreviewRoute : undefined}
          onDevPreviewRouteChange={
            isDev
              ? (route) => {
                  setDevPreviewRoute(route);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}
