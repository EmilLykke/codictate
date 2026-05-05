import { ReactNode } from "react";
import {
  WordmarkCodictate,
  wordmarkCodictateTypographyClass,
} from "../Brand/WordmarkCodictate";
import { WindowTitleBar } from "../Common/WindowTitleBar";
import type { PlatformRuntime as Platform } from "../../../shared/platform";

export type SidebarTab =
  | "home"
  | "dictionary"
  | "modes"
  | "formatting"
  | "shortcuts"
  | "transcription"
  | "audio";

const MAIN_FEATURES: { id: SidebarTab; label: string; icon: ReactNode }[] = [
  {
    id: "home",
    label: "Home",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="7" height="7" x="3" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="14" rx="1" />
        <rect width="7" height="7" x="3" y="14" rx="1" />
      </svg>
    ),
  },
  {
    id: "dictionary",
    label: "Dictionary",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  {
    id: "modes",
    label: "Modes",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
    ),
  },
  {
    id: "formatting",
    label: "Formatting",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
        <path d="m15 5 4 4" />
      </svg>
    ),
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="20" height="16" x="2" y="4" rx="2" ry="2" />
        <path d="M6 8h.01" />
        <path d="M10 8h.01" />
        <path d="M14 8h.01" />
        <path d="M18 8h.01" />
        <path d="M8 12h.01" />
        <path d="M12 12h.01" />
        <path d="M16 12h.01" />
        <path d="M7 16h10" />
      </svg>
    ),
  },
];

const CONFIGURATION_GROUP: {
  id: SidebarTab;
  label: string;
  icon: ReactNode;
}[] = [
  {
    id: "transcription",
    label: "Transcription",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" x2="15" y1="20" y2="20" />
        <line x1="12" x2="12" y1="4" y2="20" />
      </svg>
    ),
  },
  {
    id: "audio",
    label: "Audio",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    ),
  },
];

interface AppLayoutProps {
  platform: Platform;
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onWordmarkSecretTap: () => void;
  children: ReactNode;
}

export function AppLayout({
  platform,
  activeTab,
  onTabChange,
  onOpenSettings,
  onOpenHelp,
  onWordmarkSecretTap,
  children,
}: AppLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-codictate-page text-white select-none">
      <WindowTitleBar platform={platform} />

      {/* Sidebar — floating glass card */}
      <div className="shrink-0 flex flex-col p-3 pb-3 pt-10">
        <div className="glass-sidebar flex-1 flex w-[232px] flex-col px-3 pb-6 pt-5">
          <div className="mb-8">
            <button
              type="button"
              onClick={onWordmarkSecretTap}
              className="cursor-pointer rounded-lg outline-none transition-opacity duration-200 hover:opacity-95 focus-visible:ring-2 focus-visible:ring-white/20"
              aria-label="Codictate"
            >
              <WordmarkCodictate
                as="h1"
                className={`text-[30px] ${wordmarkCodictateTypographyClass}`}
              />
            </button>
          </div>

          <nav className="flex flex-col gap-1">
            {MAIN_FEATURES.map((c) => {
              const isActive = activeTab === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => onTabChange(c.id)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-medium transition-colors duration-200 cursor-pointer ${
                    isActive
                      ? "bg-white/10 text-white/90"
                      : "text-white/50 hover:bg-white/5 hover:text-white/70"
                  }`}
                >
                  <div className={isActive ? "text-white/80" : "text-white/40"}>
                    {c.icon}
                  </div>
                  {c.label}
                </button>
              );
            })}

            <div className="my-2 h-px bg-white/10 mx-3" />

            {CONFIGURATION_GROUP.map((c) => {
              const isActive = activeTab === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => onTabChange(c.id)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-medium transition-colors duration-200 cursor-pointer ${
                    isActive
                      ? "bg-white/10 text-white/90"
                      : "text-white/50 hover:bg-white/5 hover:text-white/70"
                  }`}
                >
                  <div className={isActive ? "text-white/80" : "text-white/40"}>
                    {c.icon}
                  </div>
                  {c.label}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto flex flex-col gap-1 pt-4">
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-medium text-white/50 hover:bg-white/5 hover:text-white/70 transition-colors duration-200 cursor-pointer"
            >
              <div className="text-white/40">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              Settings
            </button>
            <button
              onClick={onOpenHelp}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-medium text-white/50 hover:bg-white/5 hover:text-white/70 transition-colors duration-200 cursor-pointer"
            >
              <div className="text-white/40">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" x2="12.01" y1="17" y2="17" />
                </svg>
              </div>
              Help
            </button>
          </div>
        </div>
      </div>

      {/* Content Area — left-aligned */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-16 pt-12">
        {children}
      </div>
    </div>
  );
}
