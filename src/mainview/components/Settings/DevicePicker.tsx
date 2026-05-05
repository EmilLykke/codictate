import { motion } from "motion/react";

interface DevicePickerProps {
  devices: Record<string, string>;
  selectedDevice: number;
  onChange: (index: number) => void;
}

export function DevicePicker({
  devices,
  selectedDevice,
  onChange,
}: DevicePickerProps) {
  const entries = Object.entries(devices);

  if (entries.length === 0) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/11 bg-white/4">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white/38 shrink-0"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
        <span className="text-[17px] text-white/50 font-sans">
          No microphones found
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([indexStr, name]) => {
        const index = Number(indexStr);
        const isActive = index === selectedDevice;
        return (
          <motion.button
            key={indexStr}
            onClick={() => onChange(index)}
            className={`relative flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors duration-200 cursor-pointer text-left ${
              isActive
                ? "border-white/26 bg-white/6"
                : "border-white/11 bg-white/4 hover:border-white/16 hover:bg-white/6"
            }`}
          >
            <div
              className="shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors duration-200"
              style={{
                borderColor: isActive
                  ? "rgba(255,255,255,0.38)"
                  : "rgba(255,255,255,0.18)",
              }}
            >
              {isActive && (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 25 }}
                  className="w-2 h-2 rounded-full bg-white/60"
                />
              )}
            </div>

            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`shrink-0 transition-colors duration-200 ${isActive ? "text-white/45" : "text-white/32"}`}
            >
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>

            <span
              className={`text-[17px] font-medium truncate font-sans transition-colors duration-200 ${isActive ? "text-white/72" : "text-white/52"}`}
            >
              {name}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
