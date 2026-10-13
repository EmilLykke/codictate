import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AppSettings,
  FileTranscriptionSettingsPatch,
} from "../../../shared/types";
import {
  SPEECH_MODELS,
  coerceTranscriptionLanguageIdForModel,
  getSpeechModel,
  type SpeechModel,
} from "../../../shared/speech-models";
import {
  dismissFileTranscriptionNotice,
  fetchSettings,
  updateFileTranscriptionSettings,
} from "../../rpc";
import { DropdownSelect } from "../Common/DropdownSelect";
import { HealNotices } from "../Common/HealNotices";
import { Switch } from "../Common/Switch";
import { LanguagePicker } from "../Settings/LanguagePicker";
import { CARD, LINK } from "./transcribe-styles";

const LABEL = "text-[13px] text-overlay/45";

/** `Large V3`, or `Large V3 · Q5_0` when another installed model has the same name. */
function modelOptionLabel(
  model: SpeechModel,
  installed: SpeechModel[],
): string {
  const shared = installed.some(
    (other) => other.id !== model.id && other.label === model.label,
  );
  if (!shared) return model.label;
  const quantization = model.id.match(/-(q\d+_[0-9a-z]+|f16|f32)$/i)?.[1];
  return `${model.label} · ${quantization?.toUpperCase() ?? "Full precision"}`;
}

/**
 * The File Transcription Settings, on the Transcribe page: which Speech Model, which
 * Transcription Language and whether to Translate to English, chosen apart from Dictation's.
 *
 * The main process owns them. A change is shown at once and sent; the settings push that
 * follows has the truth, so a refused change snaps back. Readiness and heal notices are
 * rendered as shipped, never worked out here (ADR-0005).
 */
export function TranscribeSettings({
  settings,
  onOpenModels,
}: {
  settings: AppSettings;
  onOpenModels: () => void;
}) {
  const queryClient = useQueryClient();
  const file = settings.fileTranscription;
  const readiness = file.translateReadiness;

  const installed = useMemo(
    () =>
      SPEECH_MODELS.filter(
        (model) =>
          model.bundled ||
          settings.modelAvailability[model.id] ||
          model.id === file.speechModelId,
      ),
    [settings.modelAvailability, file.speechModelId],
  );

  const apply = useCallback(
    async (patch: FileTranscriptionSettingsPatch) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              fileTranscription: { ...old.fileTranscription, ...patch },
            }
          : old,
      );
      const ok = await updateFileTranscriptionSettings(patch);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [queryClient],
  );

  const handleModelChange = useCallback(
    (speechModelId: string) => {
      if (speechModelId === file.speechModelId) return;
      const transcriptionLanguageId = coerceTranscriptionLanguageIdForModel(
        speechModelId,
        file.transcriptionLanguageId,
      );
      void apply({
        speechModelId,
        ...(transcriptionLanguageId !== file.transcriptionLanguageId
          ? { transcriptionLanguageId }
          : {}),
      });
    },
    [apply, file.speechModelId, file.transcriptionLanguageId],
  );

  const handleLanguageChange = useCallback(
    (transcriptionLanguageId: string) => {
      if (transcriptionLanguageId === file.transcriptionLanguageId) return;
      void apply({ transcriptionLanguageId });
    },
    [apply, file.transcriptionLanguageId],
  );

  const handleDismiss = useCallback(async () => {
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            fileTranscription: {
              ...old.fileTranscription,
              healAnnouncements: [],
            },
          }
        : old,
    );
    const ok = await dismissFileTranscriptionNotice();
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [queryClient]);

  // Turning Translate off is always allowed; turning it on only when it can run.
  const translateLocked = !file.translateToEnglish && !readiness.ready;

  return (
    <div className="mt-3">
      <HealNotices
        announcements={file.healAnnouncements}
        onDismiss={() => void handleDismiss()}
      />

      <div className={`${CARD} px-4 py-3.5`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className={LABEL}>Speech model</span>
              <button
                type="button"
                onClick={onOpenModels}
                className={`text-[13px] ${LINK}`}
              >
                Get more models
              </button>
            </div>
            <DropdownSelect
              value={file.speechModelId}
              onChange={handleModelChange}
              ariaLabel="Speech model for files"
              align="start"
              placeholder={
                getSpeechModel(file.speechModelId)?.label ?? file.speechModelId
              }
              options={installed.map((model) => ({
                value: model.id,
                label: modelOptionLabel(model, installed),
              }))}
            />
          </div>
          <div className="min-w-0">
            <div className={`mb-2 ${LABEL}`}>Language</div>
            <LanguagePicker
              value={file.transcriptionLanguageId}
              onChange={handleLanguageChange}
              speechModelId={file.speechModelId}
              ariaLabel="Language for files"
            />
          </div>
        </div>

        <div className="mt-4 flex items-start justify-between gap-4 border-t border-overlay/8 pt-3.5">
          <div className="min-w-0">
            <p
              className={`text-[15px] ${translateLocked ? "text-overlay/45" : "text-overlay/80"}`}
            >
              Translate to English
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-overlay/40">
              {readiness.ready
                ? "Get the transcript in English."
                : readiness.message}
            </p>
          </div>
          <div className="pt-0.5">
            <Switch
              checked={file.translateToEnglish}
              onCheckedChange={(translateToEnglish) =>
                void apply({ translateToEnglish })
              }
              disabled={translateLocked}
              aria-label="Translate files to English"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
