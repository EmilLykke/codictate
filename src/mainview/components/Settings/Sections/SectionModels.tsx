import { useMemo, useState } from "react";
import type { AppSettings } from "../../../../shared/types";
import {
  SPEECH_MODELS,
  BROWSABLE_SPEECH_MODELS,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  PARAKEET_PREPARING_SETTINGS_HINT,
} from "../../../../shared/speech-models";
import { ModelPicker } from "../ModelPicker";
import { ModelBrowseModal } from "../ModelBrowseModal";
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
  const [isBrowseOpen, setIsBrowseOpen] = useState(false);

  // Preparation is automatic and starts the moment Parakeet becomes the selection, so this is
  // a statement of what is happening rather than a warning about a first run. The three
  // conditions are exactly the ones that make a preparation possible; when the main process
  // reports it finished, the settings push takes the line away without a restart.
  const isPreparingParakeet =
    settings.whisperModelId === DEFAULT_STREAM_CAPABLE_MODEL_ID &&
    modelAvailability[DEFAULT_STREAM_CAPABLE_MODEL_ID] === true &&
    !settings.parakeetCoreMlReady;

  // Curated whisper.cpp models, plus anything the user has already downloaded - hviske
  // included, even though no hviske entry is ever curated.
  //
  // Listing an installed model is management, not promotion: promotion is what `curated`
  // and the browse modal decide, and an hviske model only becomes available by being
  // deliberately downloaded from there. Leaving it out was a defect rather than a choice -
  // this is the only surface with a delete affordance, so a downloaded hviske model had no
  // way back off disk and its 150-500 MB stayed unreclaimable.
  const whisperModels = useMemo(
    () =>
      SPEECH_MODELS.filter((m) =>
        m.engine === "whisper_cpp"
          ? m.curated || modelAvailability[m.id]
          : m.engine === "hviske" && modelAvailability[m.id],
      ),
    [modelAvailability],
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
        <button
          type="button"
          onClick={() => setIsBrowseOpen(true)}
          className="flex items-center gap-1.5 mt-3 text-[13px] text-overlay/40 hover:text-accent-blue/70 transition-colors cursor-pointer"
        >
          Browse more models
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
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </button>
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
        {isPreparingParakeet && (
          <p className={`${settingsHelperClass} text-accent-amber/55`}>
            {PARAKEET_PREPARING_SETTINGS_HINT}
          </p>
        )}
      </div>

      <ModelBrowseModal
        isOpen={isBrowseOpen}
        onClose={() => setIsBrowseOpen(false)}
        models={BROWSABLE_SPEECH_MODELS}
        modelAvailability={modelAvailability}
        downloadProgress={downloadProgress}
        onDownload={onModelDownload}
        onCancelDownload={onCancelDownload}
      />
    </div>
  );
}
