import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings, ShortcutId } from "../../../../shared/types";
import {
  dictationHoldOnlyShortcutHint,
  dictationShortcutBehaviorHint,
  platformShortcutSupportHint,
} from "../../../../shared/shortcut-options";
import { setShortcut, setShortcutHoldOnly } from "../../../rpc";
import { ShortcutPicker } from "../ShortcutPicker";
import { HoldOnlyShortcutPicker } from "../HoldOnlyShortcutPicker";
import { settingsHelperClass } from "../settings-shared";

type Props = {
  settings: AppSettings;
};

export function SectionShortcuts({ settings }: Props) {
  const queryClient = useQueryClient();

  const handleShortcutChange = useCallback(
    async (id: ShortcutId) => {
      queryClient.setQueryData(["settings"], {
        ...settings,
        shortcutId: id,
        shortcutHoldOnlyId:
          settings.shortcutHoldOnlyId === id
            ? null
            : settings.shortcutHoldOnlyId,
      });
      await setShortcut(id);
    },
    [queryClient, settings],
  );

  const handleHoldOnlyShortcutChange = useCallback(
    async (id: ShortcutId | null) => {
      queryClient.setQueryData(["settings"], {
        ...settings,
        shortcutHoldOnlyId: id,
      });
      await setShortcutHoldOnly(id);
    },
    [queryClient, settings],
  );

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[18px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Main shortcut
        </h2>
        <ShortcutPicker
          value={settings.shortcutId}
          onChange={handleShortcutChange}
          platform={settings.capabilities.platform}
        />
        <p className={settingsHelperClass}>{dictationShortcutBehaviorHint()}</p>
        {platformShortcutSupportHint(settings.capabilities.platform) && (
          <p className={`${settingsHelperClass} text-amber-200/55`}>
            {platformShortcutSupportHint(settings.capabilities.platform)}
          </p>
        )}
      </div>

      <div className="mb-8">
        <h2 className="text-[18px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Hold-only shortcut
        </h2>
        <HoldOnlyShortcutPicker
          value={settings.shortcutHoldOnlyId}
          mainShortcutId={settings.shortcutId}
          onChange={handleHoldOnlyShortcutChange}
          platform={settings.capabilities.platform}
        />
        <p className={settingsHelperClass}>{dictationHoldOnlyShortcutHint()}</p>
      </div>
    </>
  );
}
