import { ReactNode } from "react";
import {
  WordmarkCodictate,
  wordmarkCodictateTypographyClass,
} from "../Brand/WordmarkCodictate";
import { WindowTitleBar } from "../Common/WindowTitleBar";
import type { PlatformRuntime as Platform } from "../../../shared/platform";
import { openExternalUrl } from "../../rpc";

export type SidebarTab =
  | "home"
  | "dictionary"
  | "models"
  | "formatting"
  | "history"
  | "stats";

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
    id: "models",
    label: "Models",
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
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M15 2v2" />
        <path d="M15 20v2" />
        <path d="M2 15h2" />
        <path d="M2 9h2" />
        <path d="M20 15h2" />
        <path d="M20 9h2" />
        <path d="M9 2v2" />
        <path d="M9 20v2" />
      </svg>
    ),
  },
  {
    id: "history",
    label: "History",
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
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l4 2" />
      </svg>
    ),
  },
  {
    id: "stats",
    label: "Stats",
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
        <path d="M3 3v18h18" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      </svg>
    ),
  },
  {
    id: "formatting",
    label: "Auto-polish",
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
];

interface AppLayoutProps {
  platform: Platform;
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onOpenSettings: () => void;
  onWordmarkSecretTap: () => void;
  children: ReactNode;
}

export function AppLayout({
  platform,
  activeTab,
  onTabChange,
  onOpenSettings,
  onWordmarkSecretTap,
  children,
}: AppLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-codictate-page text-codictate-foreground select-none">
      <WindowTitleBar platform={platform} />

      {/* Sidebar — floating glass card */}
      <div className="shrink-0 flex flex-col p-3 pb-3 pt-10">
        <div className="glass-sidebar flex-1 flex w-[232px] flex-col px-3 pb-6 pt-5">
          <div className="mb-8">
            <button
              type="button"
              onClick={onWordmarkSecretTap}
              className="cursor-pointer rounded-lg outline-none transition-opacity duration-200 hover:opacity-95 focus-visible:ring-2 focus-visible:ring-overlay/20"
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
                      ? "bg-surface-3 text-overlay/90"
                      : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                  }`}
                >
                  <div
                    className={isActive ? "text-overlay/80" : "text-overlay/40"}
                  >
                    {c.icon}
                  </div>
                  {c.label}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto flex flex-col gap-1 pt-4">
            <div className="mb-2 h-px bg-surface-3 mx-3" />
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-medium text-overlay/50 hover:bg-surface-1 hover:text-overlay/70 transition-colors duration-200 cursor-pointer"
            >
              <div className="text-overlay/40">
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
              onClick={() => openExternalUrl("https://codictate.app/support")}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-medium text-overlay/50 hover:bg-surface-1 hover:text-overlay/70 transition-colors duration-200 cursor-pointer"
            >
              <div className="text-overlay/40">
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
      {activeTab === "home" ? (
        <div className="min-h-0 flex-1 flex flex-col px-8 pt-12">
          {children}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-16 pt-12">
          <div className="max-w-3xl">{children}</div>
        </div>
      )}
    </div>
  );
}
