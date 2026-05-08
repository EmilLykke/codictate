import { useMemo } from "react";
import type { AppSettings } from "../../../../shared/types";
import {
  SPEECH_MODELS,
  PARAKEET_FIRST_RUN_SETTINGS_HINT,
} from "../../../../shared/speech-models";
import { ModelPicker } from "../ModelPicker";
import { settingsHelperClass } from "../settings-shared";
import { openExternalUrl } from "../../../rpc";

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
      <div className="mb-6">
        <div className="flex items-start justify-between">
          <h2 className="text-[28px] tracking-tight text-overlay/90">Models</h2>
          <button
            type="button"
            onClick={() => openExternalUrl("https://codictate.app/about")}
            className="flex items-center gap-1.5 mt-2 text-[13px] text-overlay/40 hover:text-accent-blue/70 transition-colors cursor-pointer"
          >
            View benchmarks
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </button>
        </div>
        <p className="mt-3 text-[14px] text-overlay/44 leading-relaxed font-sans font-normal">
          Speech-to-text engines that power your dictation.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
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
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
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
        <p className={`${settingsHelperClass} text-accent-amber/55`}>
          {PARAKEET_FIRST_RUN_SETTINGS_HINT}
        </p>
      </div>
    </div>
  );
}
