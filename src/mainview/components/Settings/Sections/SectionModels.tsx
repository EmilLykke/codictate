import { useMemo } from "react";
import type { AppSettings } from "../../../../shared/types";
import {
  SPEECH_MODELS,
  PARAKEET_FIRST_RUN_SETTINGS_HINT,
} from "../../../../shared/speech-models";
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

export function SectionModels({
  settings,
  modelAvailability,
  downloadProgress,
  onModelSelect,
  onModelDownload,
  onCancelDownload,
  onModelDelete,
}: Props) {
  const whisperModels = useMemo(
    () => SPEECH_MODELS.filter((m) => m.engine === "whisper_cpp"),
    [],
  );
  const nvidiaModels = useMemo(
    () => SPEECH_MODELS.filter((m) => m.engine === "whisperkit"),
    [],
  );

  return (
    <div className="min-w-0">
      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Whisper
        </h2>
        <ModelPicker
          value={settings.whisperModelId}
          models={whisperModels}
          modelAvailability={modelAvailability}
          downloadProgress={downloadProgress}
          onSelect={onModelSelect}
          onDownload={onModelDownload}
          onCancelDownload={onCancelDownload}
          onDelete={onModelDelete}
        />
        <p className={settingsHelperClass}>
          Turbo is bundled and works out of the box. Small and Large support
          translation to English.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          NVIDIA
        </h2>
        <ModelPicker
          value={settings.whisperModelId}
          models={nvidiaModels}
          modelAvailability={modelAvailability}
          downloadProgress={downloadProgress}
          onSelect={onModelSelect}
          onDownload={onModelDownload}
          onCancelDownload={onCancelDownload}
          onDelete={onModelDelete}
        />
        <p className={settingsHelperClass}>
          Parakeet enables live stream dictation with local NVIDIA ASR. Does not
          support translation.
        </p>
        <p className={`${settingsHelperClass} text-amber-200/55`}>
          {PARAKEET_FIRST_RUN_SETTINGS_HINT}
        </p>
      </div>
    </div>
  );
}
