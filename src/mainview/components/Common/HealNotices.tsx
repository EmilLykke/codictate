import { useEffect, useState } from "react";
import type { BlockedDictationPlan } from "../../../shared/dictation-plan";
import type { SettingsHealAnnouncement } from "../../../shared/settings-heal";

/**
 * What the app changed behind the user's back, and what it refused to do, said out loud.
 *
 * Two notices, one banner slot, one channel. The main process decides both the fact and the
 * wording (see docs/adr/0005-no-runtime-fallbacks-for-dictation.md); this renders it and
 * derives nothing. Both ride the settings payload, so they arrive again with every unrelated
 * settings push - hence dismissal is keyed on *what the notice says* rather than on a timer or
 * an id, and only a genuinely different notice reappears after a dismissal.
 *
 * Each notice keeps its own key. They share a payload, not a fate: dismissing a correction
 * that already happened should not also dismiss the reason a Dictation just refused to run.
 *
 * The blocked notice comes first and in red: it is the reason a Dictation the user asked for
 * produced nothing, where the amber rows below are corrections that already happened. When
 * the main window is closed the same sentence goes out as a native notification instead.
 */
export function HealNotices({
  announcements,
  blocked = null,
}: {
  announcements: SettingsHealAnnouncement[];
  blocked?: BlockedDictationPlan | null;
}) {
  // One key per notice, not one for both. They arrive on the same payload but they are
  // independent facts with independent dismiss buttons, and a single shared key meant
  // dismissing the amber row also hid the red one - then a change to either row produced a
  // new combined key and resurrected both.
  const blockedKey = blocked ? `${blocked.mode}:${blocked.reason}` : "";
  const announcementsKey = announcements
    .map((a) => `${a.target}:${a.reason}`)
    .join("|");
  const [dismissedBlocked, setDismissedBlocked] = useState<string | null>(null);
  const [dismissedAnnouncements, setDismissedAnnouncements] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!blockedKey) setDismissedBlocked(null);
  }, [blockedKey]);

  useEffect(() => {
    if (!announcementsKey) setDismissedAnnouncements(null);
  }, [announcementsKey]);

  const showBlocked = blockedKey !== "" && blockedKey !== dismissedBlocked;
  const showAnnouncements =
    announcementsKey !== "" && announcementsKey !== dismissedAnnouncements;

  if (!showBlocked && !showAnnouncements) return null;

  return (
    <div className="mb-4 flex flex-col gap-3">
      {showBlocked && blocked !== null && (
        <div className="flex items-start gap-3 rounded-xl border border-accent-red/30 bg-accent-red/10 px-4 py-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 shrink-0 text-accent-red/80"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <p
            className="min-w-0 flex-1 text-[15px] leading-relaxed text-overlay/75"
            role="alert"
          >
            {blocked.message}
          </p>
          <DismissButton onClick={() => setDismissedBlocked(blockedKey)} />
        </div>
      )}

      {showAnnouncements && (
        <div className="flex items-start gap-3 rounded-xl border border-accent-amber/30 bg-accent-amber/10 px-4 py-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 shrink-0 text-accent-amber/80"
            aria-hidden="true"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <ul className="min-w-0 flex-1 space-y-1" role="status">
            {announcements.map((announcement) => (
              <li
                key={`${announcement.target}:${announcement.reason}`}
                className="text-[15px] leading-relaxed text-overlay/75"
              >
                {announcement.message}
              </li>
            ))}
          </ul>
          <DismissButton
            onClick={() => setDismissedAnnouncements(announcementsKey)}
          />
        </div>
      )}
    </div>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dismiss"
      className="shrink-0 cursor-pointer rounded-md p-1 text-overlay/40 transition-colors hover:bg-surface-2 hover:text-overlay/70"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}
