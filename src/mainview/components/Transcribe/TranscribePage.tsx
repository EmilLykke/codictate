import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AppSettings,
  FileTranscriptionsState,
} from "../../../shared/types";
import { transcribeSettingsSummary } from "../../../shared/file-transcription-copy";
import { fetchFileTranscriptions } from "../../rpc";
import { TranscribeDropZone } from "./TranscribeDropZone";
import { TranscribeQueueItem } from "./TranscribeQueueItem";
import { TranscribeResultCard } from "./TranscribeResultCard";
import { CARD, HEADING, LINK } from "./transcribe-styles";

const EMPTY: FileTranscriptionsState = { active: [], finished: [] };

/** The page clock for elapsed time, ticking only while something runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * File Transcription in the window: drop or choose audio and video files and get the Raw
 * Transcript back. The queue is shared with the command line, so its jobs show up here
 * while they wait or run. Only this window's results are listed and kept in History.
 */
export function TranscribePage({
  settings,
  onOpenModels,
}: {
  settings: AppSettings;
  onOpenModels: () => void;
}) {
  // Pushed by the main process on every change (rpc.ts); fetched once on mount.
  const { data = EMPTY } = useQuery({
    queryKey: ["fileTranscriptions"],
    queryFn: fetchFileTranscriptions,
    staleTime: Infinity,
  });
  const now = useNow(data.active.some((item) => item.state !== "queued"));
  const summary = transcribeSettingsSummary(
    settings.speechModelId,
    settings.transcriptionLanguageId,
  );
  const empty = data.active.length === 0 && data.finished.length === 0;

  return (
    <div className="min-w-0">
      <div className="mb-6">
        <h2 className="text-[28px] tracking-tight text-overlay/90">
          Transcribe
        </h2>
        <p className="mt-3 text-[14px] text-overlay/44 leading-relaxed">
          Turn audio and video files into text. Everything stays on your
          computer.
        </p>
      </div>

      <TranscribeDropZone compact={!empty} />

      <p className="mt-3 text-[13px] text-overlay/40">
        Using {summary.model} · {summary.language} ·{" "}
        <button type="button" onClick={onOpenModels} className={LINK}>
          Change
        </button>
      </p>

      {data.active.length > 0 && (
        <div className="mt-8">
          <h3 className={HEADING}>In progress</h3>
          <div className={`${CARD} divide-y divide-overlay/8`}>
            {data.active.map((item) => (
              <TranscribeQueueItem key={item.id} item={item} nowMs={now} />
            ))}
          </div>
        </div>
      )}

      {data.finished.length > 0 && (
        <div className="mt-8">
          <h3 className={HEADING}>Done</h3>
          <div className="flex flex-col gap-3">
            {data.finished.map((outcome) => (
              <TranscribeResultCard
                key={outcome.id}
                outcome={outcome}
                onOpenModels={onOpenModels}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
