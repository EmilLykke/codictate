import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "../../../../shared/types";
import {
  setTranscriptionLanguage,
  setMaxRecordingDuration,
} from "../../../rpc";
import { TRANSCRIPTION_LANGUAGE_HINT } from "../../../../shared/transcription-languages";
import { PARAKEET_FIRST_RUN_SETTINGS_HINT } from "../../../../shared/speech-models";
import { speechModelLocksTranscriptionLanguage } from "../../../../shared/speech-models";
import { formatRecordingDurationLabel } from "../../../../shared/recording-duration-presets";
import { LanguagePicker } from "../LanguagePicker";
import { RecordingLimitPicker } from "../RecordingLimitPicker";
import { ModelPicker } from "../ModelPicker";
import { settingsHelperClass } from "../settings-shared";

type Props = {
  settings: AppSettings;
  modelAvailability: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  onModelSelect: (modelId: string) => void;
  onModelDownload: (modelId: string) => void;
  onCancelDownload: (modelId: string) => void;
  onModelDelete: (modelId: string) => void;
};

export function SectionTranscription({
  settings,
  modelAvailability,
  downloadProgress,
  onModelSelect,
  onModelDownload,
  onCancelDownload,
  onModelDelete,
}: Props) {
  const queryClient = useQueryClient();

  const handleTranscriptionLanguageChange = useCallback(
    async (transcriptionLanguageId: string) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, transcriptionLanguageId } : old,
      );
      await setTranscriptionLanguage(transcriptionLanguageId);
    },
    [queryClient],
  );

  const handleMaxRecordingDurationChange = useCallback(
    async (maxRecordingDuration: number) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, maxRecordingDuration } : old,
      );
      await setMaxRecordingDuration(maxRecordingDuration);
    },
    [queryClient],
  );

  const durationLabel = formatRecordingDurationLabel(
    settings.maxRecordingDuration,
  );

  return (
    <>
      <div className="mb-8 min-w-0">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Transcription Model
        </h2>
        <ModelPicker
          value={settings.whisperModelId}
          modelAvailability={modelAvailability}
          downloadProgress={downloadProgress}
          onSelect={onModelSelect}
          onDownload={onModelDownload}
          onCancelDownload={onCancelDownload}
          onDelete={onModelDelete}
        />
        <p className={settingsHelperClass}>
          Whisper models run locally. Turbo is bundled; others download on
          demand. Stream mode requires Parakeet. Translate to English requires
          Small or Large Whisper.
        </p>
        <p className={`${settingsHelperClass} text-amber-200/55`}>
          {PARAKEET_FIRST_RUN_SETTINGS_HINT}
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Transcription Language
        </h2>
        <LanguagePicker
          value={settings.transcriptionLanguageId}
          onChange={handleTranscriptionLanguageChange}
          speechModelId={settings.whisperModelId}
        />
        <p className={settingsHelperClass}>
          {speechModelLocksTranscriptionLanguage(settings.whisperModelId)
            ? "Parakeet auto-detects spoken language. Manual selection is disabled."
            : TRANSCRIPTION_LANGUAGE_HINT}
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Recording Limit
        </h2>
        <RecordingLimitPicker
          valueSeconds={settings.maxRecordingDuration}
          onChange={handleMaxRecordingDurationChange}
        />
        <p className={settingsHelperClass}>
          Recording stops automatically after {durationLabel} to maintain speed
          and accuracy. Longer limits use more disk space and increase
          transcription time.
        </p>
      </div>
    </>
  );
}
