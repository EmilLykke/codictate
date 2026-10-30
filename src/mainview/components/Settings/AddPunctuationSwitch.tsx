import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { PUNCTUATION_MODEL_DOWNLOAD_MB } from "../../../shared/punctuation-model-files";
import { formatModelSize } from "../../../shared/speech-models";
import type { AppSettings } from "../../../shared/types";
import { appEvents } from "../../app-events";
import {
  cancelPunctuationModelDownload,
  turnOnAddPunctuation,
  updateTranscriptionSettings,
} from "../../rpc";
import { Switch } from "../Common/Switch";

type Download = { inFlight: boolean; fraction: number; error?: string };

/**
 * "Add punctuation", always shown at the top of the Models page. The main process decides
 * what it can do: when neither the Dictation nor the File Transcription selection is hviske,
 * readiness says `not_offered_for_speech_model` (shown off) or
 * `speech_model_always_punctuates` (ekko, shown on), and the switch is disabled with
 * readiness's sentence. It also decides when the switch is on: turning it on downloads the
 * Danish punctuation model first, and `settings.addPunctuation` turns true only after a
 * verified install. Turning it off keeps the files, so turning it on again is instant.
 */
export function AddPunctuationSwitch({ settings }: { settings: AppSettings }) {
  const [download, setDownload] = useState<Download>({
    inFlight: false,
    fraction: 0,
  });

  useEffect(
    () =>
      appEvents.on("punctuationModelProgress", (data) => {
        setDownload(
          data.done
            ? { inFlight: false, fraction: 0, error: data.error }
            : { inFlight: true, fraction: data.progressFraction },
        );
      }),
    [],
  );

  const readiness = settings.dictationReadiness.addPunctuation;
  const offered =
    readiness.ready || readiness.reason === "punctuation_model_not_installed";
  const checked = offered
    ? settings.addPunctuation
    : readiness.reason === "speech_model_always_punctuates";

  const onCheckedChange = (on: boolean) => {
    if (on) {
      setDownload({ inFlight: true, fraction: 0 });
      turnOnAddPunctuation();
    } else {
      setDownload({ inFlight: false, fraction: 0 });
      void updateTranscriptionSettings({ addPunctuation: false });
    }
  };

  const percent = Math.round(download.fraction * 100);

  return (
    <div className="mb-8 rounded-xl border border-overlay/8 bg-surface-1 overflow-hidden">
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <p
            className={`text-[15px] ${offered ? "text-overlay/80" : "text-overlay/40"}`}
          >
            Add punctuation
          </p>
          <p className="mt-0.5 text-[13px] leading-snug text-overlay/40">
            Adds commas, full stops and capitals to hviske's Danish text.
            {offered &&
              !settings.punctuationModelInstalled &&
              ` Turning it on downloads a ${formatModelSize(PUNCTUATION_MODEL_DOWNLOAD_MB)} Danish punctuation model.`}
          </p>
          {!offered && (
            <p className="mt-1 text-[13px] leading-snug text-overlay/56">
              {readiness.message}
            </p>
          )}
        </div>
        <div className="pt-0.5">
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={!offered || download.inFlight}
            aria-label="Add punctuation"
          />
        </div>
      </div>

      {download.inFlight && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[12px] text-overlay/30 tabular-nums">
              Downloading {percent}%
            </span>
            <button
              type="button"
              onClick={() => cancelPunctuationModelDownload()}
              className="text-[12px] font-medium text-overlay/28 hover:text-overlay/50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
          <div className="h-1 rounded-full bg-overlay/10 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-accent-blue/40"
              initial={{ width: 0 }}
              animate={{ width: `${percent}%` }}
              transition={{ duration: 0.2 }}
            />
          </div>
        </div>
      )}

      {download.error && (
        <div className="px-4 pb-3">
          <span className="text-[13px] text-rose-300/80">{download.error}</span>
        </div>
      )}
    </div>
  );
}
