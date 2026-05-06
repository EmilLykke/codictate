import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHistoryAudio } from "../../rpc";

interface Props {
  entryId: string;
  durationMs: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ entryId, durationMs }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadAudio = useCallback(async () => {
    if (loaded || loading) return audioRef.current;
    setLoading(true);
    const dataUrl = await fetchHistoryAudio(entryId);
    if (!dataUrl) {
      setLoading(false);
      return null;
    }
    const audio = new Audio(dataUrl);
    audio.addEventListener("loadedmetadata", () => {
      setDuration(audio.duration);
    });
    audio.addEventListener("timeupdate", () => {
      setCurrentTime(audio.currentTime);
    });
    audio.addEventListener("ended", () => {
      setPlaying(false);
      setCurrentTime(0);
    });
    audioRef.current = audio;
    setLoaded(true);
    setLoading(false);
    return audio;
  }, [entryId, loaded, loading]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const togglePlay = async () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = await loadAudio();
      if (!audio) return;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      await audio.play();
      setPlaying(true);
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    audioRef.current.currentTime = fraction * duration;
    setCurrentTime(audioRef.current.currentTime);
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={togglePlay}
        disabled={loading}
        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-overlay/10 hover:bg-overlay/15 text-overlay/70 hover:text-overlay/90 transition-colors cursor-pointer disabled:opacity-40"
        aria-label={playing ? "Pause" : "Play"}
      >
        {loading ? (
          <div className="w-3 h-3 border-2 border-overlay/30 border-t-overlay/70 rounded-full animate-spin" />
        ) : playing ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 4l14 8-14 8V4z" />
          </svg>
        )}
      </button>
      <span className="text-[13px] text-overlay/40 tabular-nums w-9 text-right shrink-0">
        {formatTime(currentTime)}
      </span>
      <div
        className="flex-1 h-1.5 bg-overlay/10 rounded-full cursor-pointer group"
        onClick={handleSeek}
      >
        <div
          className="h-full bg-accent-blue/60 group-hover:bg-accent-blue/80 rounded-full transition-colors relative"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-overlay/80 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
      <span className="text-[13px] text-overlay/40 tabular-nums w-9 shrink-0">
        {formatTime(duration)}
      </span>
    </div>
  );
}
