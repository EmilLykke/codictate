import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "./Layout/AppLayout";
import { HomeScreen } from "./Home/HomeScreen";
import { SectionModels } from "./Settings/Sections/SectionModels";
import { SectionFormatting } from "./Settings/Sections/SectionFormatting";
import { SectionDictionary } from "./Settings/Sections/SectionDictionary";
import { HistorySection } from "./History/HistorySection";
import { StatsPage } from "./Stats/StatsPage";
import { TranscribePage } from "./Transcribe/TranscribePage";
import { SettingsModal } from "./Settings/SettingsModal";
import { HealNotices } from "./Common/HealNotices";
import type {
  AppStatus,
  AppSettings,
  DeviceInfo,
  DevAppPreviewRoute,
  DictationNoticeKind,
  NavigateRequest,
  SettingsTab,
  SidebarTab,
  StreamTranscriptionMode,
  TranscriptionSettingsPatch,
} from "../../shared/types";
import { AnimatePresence, motion } from "motion/react";
import { appEvents, takePendingNavigation } from "../app-events";
import {
  addDroppedFiles,
  dragHasFiles,
  readDrop,
} from "./Transcribe/dropped-file-uploads";
import {
  LARGE_V3_Q5_MODEL_ID,
  SPEECH_MODELS,
} from "../../shared/speech-models";
import { speechModelSelectionPatch } from "../../shared/speech-model-selection";
import {
  cancelModelDownload,
  deleteWhisperModel,
  dismissDictationNotice,
  downloadWhisperModel,
  fetchSettings,
  setFormattingEnabled,
  setStreamMode,
  setTranscriptionLanguage,
  setAudioDevice,
  setStreamTranscriptionMode,
  setTranslateDefaultLanguage,
  setTranslateToEnglish,
  updateTranscriptionSettings,
} from "../rpc";

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
  const [settingsTabRequestId, setSettingsTabRequestId] = useState(0);

  /**
   * The main process names a sidebar page and/or a Settings tab (tray, app menu, a
   * Command-Line Control notification). Requests that landed before this view mounted are
   * picked up on mount.
   */
  const applyNavigation = useCallback((request: NavigateRequest) => {
    if (request.tab !== undefined) setActiveTab(request.tab);
    if (request.settingsTab !== undefined) {
      setSettingsInitialTab(request.settingsTab);
      setSettingsTabRequestId((id) => id + 1);
      setIsSettingsModalOpen(true);
    }
  }, []);

  // Files dropped on any other page go to Transcribe, with a full-window "Drop to
  // transcribe" overlay while they are dragged over. On the Transcribe page its drop zone
  // takes the drop itself (and lights up), so this steps aside there. `dragleave` fires on
  // every child element, so the overlay lets go after a short pause in `dragover` instead.
  const [fileDragOver, setFileDragOver] = useState(false);
  useEffect(() => {
    if (activeTab === "transcribe") return;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      if (idle) clearTimeout(idle);
      idle = null;
      setFileDragOver(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setFileDragOver(true);
      if (idle) clearTimeout(idle);
      idle = setTimeout(release, 250);
    };
    const onDrop = (event: DragEvent) => {
      if (!dragHasFiles(event) || !event.dataTransfer) return;
      event.preventDefault();
      release();
      const { files, folders } = readDrop(event.dataTransfer);
      addDroppedFiles(files, folders);
      setActiveTab("transcribe");
    };
    window.addEventListener("dragenter", onDragOver);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("dragenter", onDragOver);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", release);
      release();
    };
  }, [activeTab]);

  useEffect(() => {
    const pending = takePendingNavigation();
    if (pending !== null) applyNavigation(pending);
    return appEvents.on("navigate", () => {
      const request = takePendingNavigation();
      if (request !== null) applyNavigation(request);
    });
  }, [applyNavigation]);

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
      async ({ modelId, progressFraction, done, error, requestedByWindow }) => {
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
          if (!error) {
            // The download was started *for* Translate to English, against the Speech Model
            // the main process named in its readiness. Nothing to re-derive here: select it
            // and ask for the toggle.
            const current =
              queryClient.getQueryData<AppSettings>(["settings"]) ??
              (await fetchSettings());
            const patch = {
              ...speechModelSelectionPatch(current, modelId),
              translateToEnglish: true,
            } satisfies TranscriptionSettingsPatch;
            queryClient.setQueryData(["settings"], { ...current, ...patch });
            const ok = await updateTranscriptionSettings(patch);
            if (!ok) {
              queryClient.setQueryData(["settings"], await fetchSettings());
            }
          }
        }

        if (!error) {
          setModelAvailability((prev) => ({ ...prev, [modelId]: true }));
          // Auto-select when downloading from the model picker (not a translate-pending flow).
          // A download only the command line asked for never selects: `models download`
          // promises not to.
          if (
            requestedByWindow &&
            pendingTranslate !== modelId &&
            modelId !== LARGE_V3_Q5_MODEL_ID
          ) {
            const current =
              queryClient.getQueryData<AppSettings>(["settings"]) ??
              (await fetchSettings());
            const patch = speechModelSelectionPatch(current, modelId);
            queryClient.setQueryData(["settings"], { ...current, ...patch });
            const ok = await updateTranscriptionSettings(patch);
            if (!ok) {
              queryClient.setQueryData(["settings"], await fetchSettings());
            }
          }
        }
      },
    );
    return unsub;
  }, [queryClient]);

  const handleModelSelect = useCallback(
    async (modelId: string) => {
      if (modelId === settings.speechModelId) return;
      const patch = speechModelSelectionPatch(settings, modelId);
      queryClient.setQueryData(["settings"], {
        ...settings,
        ...patch,
      });
      const ok = await updateTranscriptionSettings(patch);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
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
    const readiness = settings.dictationReadiness.liveTranscription;
    // Turning it *off* never needs readiness: an unrunnable Live Transcription is exactly
    // what the user is trying to get out of.
    if (!settings.streamMode && !readiness.ready) {
      // The only unavailable case with a way forward. Downloading Parakeet selects it, and
      // the settings push that follows makes the toggle live.
      if (readiness.downloadModelId !== null) {
        handleModelDownload(readiness.downloadModelId);
      }
      return;
    }
    const newValue = !settings.streamMode;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, streamMode: newValue } : old,
    );
    const ok = await setStreamMode(newValue);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [
    settings.streamMode,
    settings.dictationReadiness.liveTranscription,
    handleModelDownload,
    queryClient,
  ]);

  /**
   * Retire a banner notice in the main process, which owns whether it is still standing.
   *
   * Optimistic so the click feels immediate; the push that follows the request is what makes
   * it stick across a tab change, which remounts the banner slot.
   */
  const handleDismissNotice = useCallback(
    async (notice: DictationNoticeKind) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? notice === "heal"
            ? { ...old, healAnnouncements: [] }
            : notice === "blocked"
              ? { ...old, blockedDictation: null }
              : { ...old, dictationFailure: null }
          : old,
      );
      const ok = await dismissDictationNotice(notice);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
    },
    [queryClient],
  );

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

    const readiness = settings.dictationReadiness.translateToEnglish;

    if (readiness.ready) {
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

    // The main process already picked the Speech Model whose download unblocks Translate,
    // or said that no download does. The rest - switch to a model you already have, choose a
    // source language - is the user's move, and the toggle says which one.
    if (readiness.downloadModelId !== null) {
      const target = readiness.downloadModelId;
      translatePendingRef.current = target;
      setTranslateDownloadModelId(target);
      setDownloadProgress((prev) => ({ ...prev, [target]: 0 }));
      downloadWhisperModel(target);
    }
  }, [settings, queryClient]);

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
      <AnimatePresence>
        {fileDragOver && (
          <motion.div
            key="file-drop-overlay"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center bg-codictate-page/70 p-6 backdrop-blur-sm"
          >
            <div className="flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-accent-blue/60 bg-accent-blue/8">
              <p className="text-[20px] font-medium text-overlay/85">
                Drop to transcribe
              </p>
              <p className="mt-1.5 text-[14px] text-overlay/45">
                Audio and video files
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
          <HealNotices
            announcements={settings.healAnnouncements ?? []}
            blocked={settings.blockedDictation ?? null}
            failed={settings.dictationFailure ?? null}
            onDismiss={handleDismissNotice}
          />
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
        {activeTab === "transcribe" && (
          <TranscribePage
            settings={settings}
            onOpenModels={() => setActiveTab("models")}
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
        tabRequestId={settingsTabRequestId}
        devPreviewRoute={devPreviewRoute}
        onDevPreviewRouteChange={onDevPreviewRouteChange}
      />
    </>
  );
}
