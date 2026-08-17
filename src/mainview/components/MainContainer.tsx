import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout, type SidebarTab } from "./Layout/AppLayout";
import { HomeScreen } from "./Home/HomeScreen";
import { SectionModels } from "./Settings/Sections/SectionModels";
import { SectionFormatting } from "./Settings/Sections/SectionFormatting";
import { SectionDictionary } from "./Settings/Sections/SectionDictionary";
import { HistorySection } from "./History/HistorySection";
import { StatsPage } from "./Stats/StatsPage";
import { SettingsModal, type SettingsTab } from "./Settings/SettingsModal";
import { HealNotices } from "./Common/HealNotices";
import type {
  AppStatus,
  AppSettings,
  DeviceInfo,
  DevAppPreviewRoute,
  StreamTranscriptionMode,
} from "../../shared/types";
import { appEvents } from "../app-events";
import {
  DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID,
  isTranslateCapableModelId,
  getTranslateReadiness,
} from "../../shared/dictation-plan";
import {
  DEFAULT_MODEL_ID,
  SPEECH_MODELS,
  coerceTranscriptionLanguageIdForModel,
  getSpeechModel,
} from "../../shared/speech-models";
import {
  cancelModelDownload,
  deleteWhisperModel,
  downloadWhisperModel,
  fetchSettings,
  setFormattingEnabled,
  setStreamMode,
  setTranscriptionLanguage,
  setAudioDevice,
  setStreamTranscriptionMode,
  setTranslateDefaultLanguage,
  setTranslateToEnglish,
  setWhisperModel,
} from "../rpc";

/** The one Speech Model a finished download never auto-selects (see the handler below). */
const LARGE_V3_Q5_MODEL_ID = "large-v3-q5_0";

export function MainContainer({
  status,
  deviceInfo,
  settings,
  devPreviewRoute = null,
  onDevPreviewRouteChange,
}: {
  status: AppStatus;
  deviceInfo?: DeviceInfo;
  settings: AppSettings;
  devPreviewRoute?: DevAppPreviewRoute | null;
  onDevPreviewRouteChange?: (route: DevAppPreviewRoute | null) => void;
}) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SidebarTab>("home");
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>("general");

  // Model availability: seeded from settings (always up-to-date on fetch),
  // then kept in sync via modelAvailability events for incremental changes.
  const [modelAvailability, setModelAvailability] = useState<
    Record<string, boolean>
  >(() => {
    const defaults = Object.fromEntries(
      SPEECH_MODELS.map((m) => [m.id, m.bundled ?? false]),
    );
    return { ...defaults, ...settings.modelAvailability };
  });
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});

  /** Model id being downloaded to satisfy a translate toggle, if any. */
  const translatePendingRef = useRef<string | null>(null);
  const [translateDownloadModelId, setTranslateDownloadModelId] = useState<
    string | null
  >(null);

  useEffect(() => {
    return appEvents.on("modelAvailability", ({ modelId, available }) => {
      setModelAvailability((prev) => ({ ...prev, [modelId]: available }));
    });
  }, []);

  useEffect(() => {
    if (settings.modelAvailability) {
      setModelAvailability((prev) => ({
        ...prev,
        ...settings.modelAvailability,
      }));
    }
  }, [settings.modelAvailability]);

  useEffect(() => {
    const unsub = appEvents.on(
      "modelDownloadProgress",
      async ({ modelId, progressFraction, done, error }) => {
        if (!done) {
          setDownloadProgress((prev) => ({
            ...prev,
            [modelId]: progressFraction,
          }));
          return;
        }

        // Download finished (success or failure)
        setDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[modelId];
          return next;
        });

        const pendingTranslate = translatePendingRef.current;
        if (pendingTranslate === modelId) {
          setTranslateDownloadModelId(null);
          translatePendingRef.current = null;
          if (!error && isTranslateCapableModelId(modelId)) {
            const current = queryClient.getQueryData<AppSettings>(["settings"]);
            const sel = current?.whisperModelId ?? DEFAULT_MODEL_ID;
            if (!isTranslateCapableModelId(sel) || sel !== modelId) {
              const hadStream = current?.streamMode ?? false;
              await setWhisperModel(modelId);
              queryClient.setQueryData(["settings"], (old: AppSettings) => ({
                ...old,
                whisperModelId: modelId,
                ...(hadStream ? { streamMode: false } : {}),
              }));
              if (hadStream) {
                const ok = await setStreamMode(false);
                if (!ok) {
                  queryClient.setQueryData(["settings"], await fetchSettings());
                }
              }
            }
            const ok = await setTranslateToEnglish(true);
            if (ok) {
              queryClient.setQueryData(["settings"], (old: AppSettings) => ({
                ...old,
                translateToEnglish: true,
              }));
            } else {
              const fresh = await fetchSettings();
              queryClient.setQueryData(["settings"], fresh);
            }
          }
        }

        if (!error) {
          setModelAvailability((prev) => ({ ...prev, [modelId]: true }));
          // Auto-select when downloading from the model picker (not a translate-pending flow).
          if (
            pendingTranslate !== modelId &&
            modelId !== LARGE_V3_Q5_MODEL_ID
          ) {
            const cur = queryClient.getQueryData<AppSettings>(["settings"]);
            const hadStream = cur?.streamMode ?? false;
            const nextLang = coerceTranscriptionLanguageIdForModel(
              modelId,
              cur?.transcriptionLanguageId ?? "auto",
            );
            await setWhisperModel(modelId);
            queryClient.setQueryData(["settings"], (old: AppSettings) => ({
              ...old,
              whisperModelId: modelId,
              transcriptionLanguageId: nextLang,
              ...(hadStream ? { streamMode: false } : {}),
            }));
            if (nextLang !== cur?.transcriptionLanguageId) {
              await setTranscriptionLanguage(nextLang);
            }
            if (hadStream) {
              const ok = await setStreamMode(false);
              if (!ok) {
                queryClient.setQueryData(["settings"], await fetchSettings());
              }
            }
          }
        }
      },
    );
    return unsub;
  }, [queryClient]);

  const handleModelSelect = useCallback(
    async (modelId: string) => {
      if (modelId === settings.whisperModelId) return;
      const hadStream = settings.streamMode;
      const nextLang = coerceTranscriptionLanguageIdForModel(
        modelId,
        settings.transcriptionLanguageId,
      );
      queryClient.setQueryData(["settings"], {
        ...settings,
        whisperModelId: modelId,
        transcriptionLanguageId: nextLang,
        ...(hadStream ? { streamMode: false } : {}),
      });
      await setWhisperModel(modelId);
      if (nextLang !== settings.transcriptionLanguageId) {
        await setTranscriptionLanguage(nextLang);
      }
      if (hadStream) {
        const ok = await setStreamMode(false);
        if (!ok) {
          queryClient.setQueryData(["settings"], await fetchSettings());
        }
      }
    },
    [queryClient, settings],
  );

  const handleModelDownload = useCallback((modelId: string) => {
    setDownloadProgress((prev) => ({ ...prev, [modelId]: 0 }));
    downloadWhisperModel(modelId);
  }, []);

  const handleCancelDownload = useCallback((modelId: string) => {
    cancelModelDownload(modelId);
    if (translatePendingRef.current === modelId) {
      translatePendingRef.current = null;
      setTranslateDownloadModelId(null);
    }
    setDownloadProgress((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
  }, []);

  const handleModelDelete = useCallback((modelId: string) => {
    // Deleting weights is an availability change, so the main process heals the
    // configuration - dangling selection, Translate to English, Live Transcription - and
    // pushes the corrected settings back with whatever it had to announce. Nothing to
    // reconcile here beyond the availability flag the picker draws from.
    deleteWhisperModel(modelId);
    setModelAvailability((prev) => ({ ...prev, [modelId]: false }));
  }, []);

  const handleStreamToggle = useCallback(async () => {
    const newValue = !settings.streamMode;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, streamMode: newValue } : old,
    );
    const ok = await setStreamMode(newValue);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [settings.streamMode, queryClient]);

  const handleFormattingToggle = useCallback(async () => {
    const newValue = !(settings.formatting?.enabled ?? false);
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            formatting: { ...old.formatting, enabled: newValue },
          }
        : old,
    );
    const ok = await setFormattingEnabled(newValue);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [settings.formatting?.enabled, queryClient]);

  const handleLanguageChange = useCallback(
    async (languageId: string) => {
      queryClient.setQueryData(["settings"], (old: AppSettings) => ({
        ...old,
        transcriptionLanguageId: languageId,
      }));
      await setTranscriptionLanguage(languageId);
    },
    [queryClient],
  );

  const handleDeviceChange = useCallback(
    async (index: number) => {
      queryClient.setQueryData(["devices"], (old: DeviceInfo | undefined) =>
        old ? { ...old, selectedDevice: index } : old,
      );
      await setAudioDevice(index);
    },
    [queryClient],
  );

  const handleTranslateToggle = useCallback(async () => {
    if (settings.translateToEnglish) {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              translateToEnglish: false,
              transcriptionLanguageId: "auto",
            }
          : old,
      );
      await setTranslateToEnglish(false);
      return;
    }

    const isModelAvail = (id: string) =>
      modelAvailability[id] ?? getSpeechModel(id)?.bundled ?? false;

    const readiness = getTranslateReadiness(
      settings.whisperModelId,
      settings.transcriptionLanguageId,
      settings.translateDefaultLanguageId,
      isModelAvail,
    );

    if (readiness.kind === "ready") {
      const sourceLanguageId =
        settings.transcriptionLanguageId === "auto"
          ? settings.translateDefaultLanguageId
          : settings.transcriptionLanguageId;

      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              translateToEnglish: true,
              transcriptionLanguageId: sourceLanguageId,
            }
          : old,
      );
      const ok = await setTranslateToEnglish(true);
      if (!ok) {
        const fresh = await fetchSettings();
        queryClient.setQueryData(["settings"], fresh);
      }
      return;
    }

    if (readiness.kind === "need_download") {
      const sel = settings.whisperModelId;
      const target =
        isTranslateCapableModelId(sel) && !isModelAvail(sel)
          ? sel
          : DEFAULT_TRANSLATE_DOWNLOAD_MODEL_ID;
      translatePendingRef.current = target;
      setTranslateDownloadModelId(target);
      setDownloadProgress((prev) => ({ ...prev, [target]: 0 }));
      downloadWhisperModel(target);
      return;
    }

    // need_switch_model or need_language — handled in Settings UI / language pickers.
  }, [settings, queryClient, modelAvailability]);

  const handleStreamTranscriptionModeChange = useCallback(
    async (mode: StreamTranscriptionMode) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, streamTranscriptionMode: mode } : old,
      );
      await setStreamTranscriptionMode(mode);
    },
    [queryClient],
  );

  const handleTranslateDefaultLanguageChange = useCallback(
    async (languageId: string) => {
      if (languageId === "__translate_pick__" || languageId === "auto") return;
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, translateDefaultLanguageId: languageId } : old,
      );
      await setTranslateDefaultLanguage(languageId);
    },
    [queryClient],
  );

  return (
    <>
      <AppLayout
        platform={settings.capabilities.platform}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={() => {
          setSettingsInitialTab("general");
          setIsSettingsModalOpen(true);
        }}
        onWordmarkSecretTap={() => {}}
        banner={
          <HealNotices announcements={settings.healAnnouncements ?? []} />
        }
      >
        {activeTab === "home" && (
          <HomeScreen
            status={status}
            deviceInfo={deviceInfo}
            settings={settings}
            modelAvailability={modelAvailability}
            downloadProgress={downloadProgress}
            translateDownloadModelId={translateDownloadModelId}
            onModelChange={handleModelSelect}
            onLanguageChange={handleLanguageChange}
            onDeviceChange={handleDeviceChange}
            onStreamToggle={handleStreamToggle}
            onStreamTranscriptionModeChange={
              handleStreamTranscriptionModeChange
            }
            onFormattingToggle={handleFormattingToggle}
            onTranslateToggle={handleTranslateToggle}
            onTranslateDefaultLanguageChange={
              handleTranslateDefaultLanguageChange
            }
            onCancelDownload={handleCancelDownload}
            onOpenSettings={() => {
              setSettingsInitialTab("shortcuts");
              setIsSettingsModalOpen(true);
            }}
            onNavigateToHistory={() => setActiveTab("history")}
            onNavigateToStats={() => setActiveTab("stats")}
          />
        )}
        {activeTab === "dictionary" && (
          <SectionDictionary settings={settings} />
        )}
        {activeTab === "models" && (
          <SectionModels
            settings={settings}
            modelAvailability={modelAvailability}
            downloadProgress={downloadProgress}
            onModelSelect={handleModelSelect}
            onModelDownload={handleModelDownload}
            onCancelDownload={handleCancelDownload}
            onModelDelete={handleModelDelete}
          />
        )}
        {activeTab === "formatting" && (
          <SectionFormatting settings={settings} />
        )}
        {activeTab === "history" && (
          <HistorySection
            settings={settings}
            onOpenHistorySettings={() => {
              setSettingsInitialTab("history");
              setIsSettingsModalOpen(true);
            }}
          />
        )}
        {activeTab === "stats" && (
          <StatsPage
            settings={settings}
            onOpenStatsSettings={() => {
              setSettingsInitialTab("stats");
              setIsSettingsModalOpen(true);
            }}
          />
        )}
      </AppLayout>

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        status={status}
        initialTab={settingsInitialTab}
        devPreviewRoute={devPreviewRoute}
        onDevPreviewRouteChange={onDevPreviewRouteChange}
      />
    </>
  );
}
