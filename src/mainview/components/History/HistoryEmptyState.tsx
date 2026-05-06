import { Switch } from "../Common/Switch";
import { updateHistorySettings } from "../../rpc";

interface Props {
  storagePath: string;
}

export function HistoryEmptyState({ storagePath }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="mb-6 text-white/20">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l4 2" />
        </svg>
      </div>
      <h2 className="text-[18px] font-medium text-white/80 mb-2">
        Dictation History
      </h2>
      <p className="text-[15px] text-white/50 mb-6 max-w-sm leading-relaxed">
        Save a copy of each dictation (audio + transcript) to your computer.
      </p>
      <div className="flex items-center gap-3">
        <span className="text-[15px] text-white/60">Enable History</span>
        <Switch
          checked={false}
          onCheckedChange={(checked) => {
            if (checked) updateHistorySettings({ enabled: true });
          }}
          aria-label="Enable dictation history"
        />
      </div>
      <p className="text-[13px] text-white/30 mt-4">
        Recordings saved to {storagePath}
      </p>
    </div>
  );
}
