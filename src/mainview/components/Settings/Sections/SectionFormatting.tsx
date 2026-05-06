import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FORMATTING_MODES,
  formattingModeLabel,
} from "../../../../shared/formatting-modes";
import type {
  AppSettings,
  FormatterModelTier,
  FormattingDocumentStructure,
  FormattingDocumentTone,
  FormattingEmailClosingStyle,
  FormattingEmailGreetingStyle,
  FormattingImessageTone,
  FormattingModeId,
  FormattingSettingsPatch,
  FormattingSlackTone,
} from "../../../../shared/types";
import {
  cancelFormatterModelDownload,
  deleteFormatterModel,
  downloadFormatterModel,
  fetchSettings,
  setFormatterModelTier,
  setFormattingDocumentLightweight,
  setFormattingDocumentStructure,
  setFormattingDocumentTone,
  setFormattingEmailClosingStyle,
  setFormattingEmailCustomClosing,
  setFormattingEmailCustomGreeting,
  setFormattingEmailGreetingStyle,
  setFormattingEmailIncludeSenderName,
  setFormattingForceModeId,
  setFormattingImessageAllowEmoji,
  setFormattingImessageLightweight,
  setFormattingImessageTone,
  setFormattingModeEnabled,
  setFormattingSlackAllowEmoji,
  setFormattingSlackLightweight,
  setFormattingSlackTone,
  setFormattingSlackUseMarkdown,
} from "../../../rpc";
import { appEvents } from "../../../app-events";
import { settingsHelperClass } from "../settings-shared";
import { platformDisplayName } from "../../../../shared/platform";
import { Switch } from "../../Common/Switch";

type TileOption<T extends string> = {
  value: T;
  label: string;
  sublabel?: string;
  preview?: string;
};

const EMAIL_GREETING_OPTIONS: TileOption<FormattingEmailGreetingStyle>[] = [
  { value: "auto", label: "Auto", sublabel: "Let Codictate pick" },
  { value: "hi", label: "Hi,", sublabel: "Friendly" },
  { value: "hello", label: "Hello,", sublabel: "Classic" },
  { value: "custom", label: "Custom...", sublabel: "You decide" },
  { value: "none", label: "None", sublabel: "Skip greeting entirely" },
];

const EMAIL_CLOSING_OPTIONS: TileOption<FormattingEmailClosingStyle>[] = [
  { value: "auto", label: "Auto", sublabel: "Let Codictate pick" },
  { value: "best-regards", label: "Best regards,", sublabel: "Professional" },
  { value: "thanks", label: "Thanks,", sublabel: "Grateful" },
  { value: "kind-regards", label: "Kind regards,", sublabel: "Warm" },
  { value: "custom", label: "Custom...", sublabel: "You decide" },
  { value: "none", label: "None", sublabel: "Skip sign-off entirely" },
];

const IMESSAGE_TONE_OPTIONS: TileOption<FormattingImessageTone>[] = [
  {
    value: "formal",
    label: "Formal.",
    sublabel: "Caps + Punctuation",
    preview:
      "Hey, are you free for lunch tomorrow? Let's do 12 if that works for you.",
  },
  {
    value: "neutral",
    label: "Casual",
    sublabel: "Caps + Less punctuation",
    preview:
      "Hey are you free for lunch tomorrow? Let's do 12 if that works for you",
  },
  {
    value: "casual",
    label: "very casual",
    sublabel: "No Caps + Less punctuation",
    preview:
      "hey are you free for lunch tomorrow? let's do 12 if that works for you",
  },
];

const SLACK_TONE_OPTIONS: TileOption<FormattingSlackTone>[] = [
  {
    value: "professional",
    label: "Formal.",
    sublabel: "Caps + Full punctuation",
    preview: "Heads up: the new build is live. Please flag any regressions.",
  },
  {
    value: "neutral",
    label: "Casual",
    sublabel: "Caps + Light punctuation",
    preview:
      "Heads up, the new build is live. Let me know if anything looks off",
  },
  {
    value: "casual",
    label: "very casual",
    sublabel: "No Caps + Relaxed",
    preview:
      "quick update -- the new build is out, let me know if anything breaks",
  },
];

const DOCUMENT_TONE_OPTIONS: TileOption<FormattingDocumentTone>[] = [
  {
    value: "formal",
    label: "Formal.",
    sublabel: "Polished writing",
    preview:
      "This document outlines the outcome of the discussion and next steps.",
  },
  {
    value: "neutral",
    label: "Casual",
    sublabel: "Clear & direct",
    preview: "Summary of the discussion and the action items we agreed on.",
  },
  {
    value: "casual",
    label: "very casual",
    sublabel: "Relaxed prose",
    preview:
      "So here's where we landed after the chat -- a few things to lock in.",
  },
];

const DOCUMENT_STRUCTURE_OPTIONS: TileOption<FormattingDocumentStructure>[] = [
  {
    value: "prose",
    label: "Flowing prose",
    sublabel: "Short paragraphs",
    preview:
      "The team agreed on the roadmap. Design leads on the UI pass, engineering wraps the API.",
  },
  {
    value: "bulleted",
    label: "Bulleted",
    sublabel: "List when it fits",
    preview:
      "- Design: UI pass this week\n- Engineering: API wrap-up\n- Review Friday",
  },
];

const LIGHT_AI_LOCKED_HINT =
  "These use the on-device LLM. Turn off light formatting above to change them.";

const MODE_ICONS: Record<FormattingModeId, React.ReactNode> = {
  email: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  ),
  imessage: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  ),
  slack: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="3" height="8" x="13" y="2" rx="1.5" />
      <path d="M19 8.5V10h1.5A1.5 1.5 0 1 0 19 8.5" />
      <rect width="3" height="8" x="8" y="14" rx="1.5" />
      <path d="M5 15.5V14H3.5A1.5 1.5 0 1 0 5 15.5" />
      <rect width="8" height="3" x="14" y="13" rx="1.5" />
      <path d="M15.5 19H14v1.5a1.5 1.5 0 1 0 1.5-1.5" />
      <rect width="8" height="3" x="2" y="8" rx="1.5" />
      <path d="M8.5 5H10V3.5A1.5 1.5 0 1 0 8.5 5" />
    </svg>
  ),
  document: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 13H8" />
      <path d="M16 17H8" />
      <path d="M16 13h-2" />
    </svg>
  ),
};

const MODE_DESCRIPTIONS: Record<FormattingModeId, string> = {
  email: "Mail, Outlook, Spark, Superhuman, Mimestream",
  imessage: "Apple Messages",
  slack: "Slack desktop",
  document: "Notes, Pages, Word, Google Docs",
};

function LightLockedShell({
  locked,
  hint,
  children,
}: {
  locked: boolean;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        className={
          locked ? "opacity-[0.36] pointer-events-none select-none" : undefined
        }
      >
        {children}
      </div>
      {locked ? (
        <p className="px-4 pb-3.5 pt-0.5 text-[15px] text-overlay/44 leading-snug">
          {hint}
        </p>
      ) : null}
    </>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: () => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <span
          className={`block text-[15px] font-medium ${checked ? "text-overlay/78" : "text-overlay/58"}`}
        >
          {label}
        </span>
        <span className="mt-0.5 block text-[12px] text-overlay/40 leading-snug">
          {description}
        </span>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={() => onCheckedChange()}
        aria-label={ariaLabel}
      />
    </div>
  );
}

type Props = {
  settings: AppSettings;
};

export function SectionFormatting({ settings }: Props) {
  const queryClient = useQueryClient();
  const formatting = settings.formatting;
  const [expandedMode, setExpandedMode] = useState<FormattingModeId | null>(
    null,
  );
  const [customGreetingDraft, setCustomGreetingDraft] = useState("");
  const [customClosingDraft, setCustomClosingDraft] = useState("");
  type TierDownloadState = {
    inFlight: boolean;
    fraction: number;
    error?: string;
  };
  const [tierDownloads, setTierDownloads] = useState<
    Record<FormatterModelTier, TierDownloadState>
  >({
    fast: { inFlight: false, fraction: 0 },
    quality: { inFlight: false, fraction: 0 },
  });

  useEffect(() => {
    return appEvents.on("formatterModelProgress", (data) => {
      setTierDownloads((prev) => ({
        ...prev,
        [data.tier]: {
          inFlight: !data.done,
          fraction: data.progressFraction,
          error: data.error,
        },
      }));
    });
  }, []);

  const handleDownloadFormatterModel = useCallback(
    (tier: FormatterModelTier) => {
      setTierDownloads((prev) => ({
        ...prev,
        [tier]: { inFlight: true, fraction: 0 },
      }));
      downloadFormatterModel(tier);
    },
    [],
  );

  const handleCancelFormatterDownload = useCallback(() => {
    cancelFormatterModelDownload();
    setTierDownloads({
      fast: { inFlight: false, fraction: 0 },
      quality: { inFlight: false, fraction: 0 },
    });
  }, []);

  const handleDeleteFormatterModel = useCallback((tier: FormatterModelTier) => {
    deleteFormatterModel(tier);
  }, []);

  const handleFormatterModelTierChange = useCallback(
    async (tier: FormatterModelTier) => {
      const ok = await setFormatterModelTier(tier);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
    },
    [queryClient],
  );

  useEffect(() => {
    setCustomGreetingDraft(formatting.email.customGreeting);
  }, [formatting.email.customGreeting]);

  useEffect(() => {
    setCustomClosingDraft(formatting.email.customClosing);
  }, [formatting.email.customClosing]);

  const mergeFormatting = useCallback(
    (old: AppSettings, patch: FormattingSettingsPatch): AppSettings => {
      const nextFormatting: AppSettings["formatting"] = {
        ...old.formatting,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.forceModeId !== undefined
          ? { forceModeId: patch.forceModeId }
          : {}),
        ...(patch.enabledModes
          ? {
              enabledModes: {
                ...old.formatting.enabledModes,
                ...patch.enabledModes,
              },
            }
          : {}),
        ...(patch.email
          ? { email: { ...old.formatting.email, ...patch.email } }
          : {}),
        ...(patch.imessage
          ? { imessage: { ...old.formatting.imessage, ...patch.imessage } }
          : {}),
        ...(patch.slack
          ? { slack: { ...old.formatting.slack, ...patch.slack } }
          : {}),
        ...(patch.document
          ? { document: { ...old.formatting.document, ...patch.document } }
          : {}),
      };
      return { ...old, formatting: nextFormatting };
    },
    [],
  );

  const handleFormattingModeToggle = useCallback(
    async (modeId: FormattingModeId) => {
      const current = formatting.enabledModes[modeId] ?? false;
      const newValue = !current;
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? mergeFormatting(old, { enabledModes: { [modeId]: newValue } })
          : old,
      );
      const ok = await setFormattingModeEnabled(modeId, newValue);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
    },
    [formatting.enabledModes, mergeFormatting, queryClient],
  );

  const handleClearFormattingForce = useCallback(async () => {
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { forceModeId: null }) : old,
    );
    const ok = await setFormattingForceModeId(null);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [mergeFormatting, queryClient]);

  const handleCustomGreetingCommit = useCallback(async () => {
    const text = customGreetingDraft.trim();
    if (text === formatting.email.customGreeting) return;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { email: { customGreeting: text } }) : old,
    );
    await setFormattingEmailCustomGreeting(text);
  }, [
    customGreetingDraft,
    formatting.email.customGreeting,
    mergeFormatting,
    queryClient,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void handleCustomGreetingCommit();
    }, 600);
    return () => clearTimeout(timer);
  }, [customGreetingDraft, handleCustomGreetingCommit]);

  const handleCustomClosingCommit = useCallback(async () => {
    const text = customClosingDraft.trim();
    if (text === formatting.email.customClosing) return;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { email: { customClosing: text } }) : old,
    );
    await setFormattingEmailCustomClosing(text);
  }, [
    customClosingDraft,
    formatting.email.customClosing,
    mergeFormatting,
    queryClient,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void handleCustomClosingCommit();
    }, 600);
    return () => clearTimeout(timer);
  }, [customClosingDraft, handleCustomClosingCommit]);

  const handleEmailGreetingStyleChange = useCallback(
    async (style: FormattingEmailGreetingStyle) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { email: { greetingStyle: style } }) : old,
      );
      const ok = await setFormattingEmailGreetingStyle(style);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [mergeFormatting, queryClient],
  );

  const handleEmailClosingStyleChange = useCallback(
    async (style: FormattingEmailClosingStyle) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { email: { closingStyle: style } }) : old,
      );
      const ok = await setFormattingEmailClosingStyle(style);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [mergeFormatting, queryClient],
  );

  const handleImessageToneChange = useCallback(
    async (tone: FormattingImessageTone) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { imessage: { tone } }) : old,
      );
      const ok = await setFormattingImessageTone(tone);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [mergeFormatting, queryClient],
  );

  const handleFormattingImessageAllowEmojiToggle = useCallback(async () => {
    const newValue = !formatting.imessage.allowEmoji;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { imessage: { allowEmoji: newValue } }) : old,
    );
    const ok = await setFormattingImessageAllowEmoji(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.imessage.allowEmoji, mergeFormatting, queryClient]);

  const handleFormattingImessageLightweightToggle = useCallback(async () => {
    const newValue = !formatting.imessage.lightweight;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { imessage: { lightweight: newValue } }) : old,
    );
    const ok = await setFormattingImessageLightweight(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.imessage.lightweight, mergeFormatting, queryClient]);

  const handleSlackToneChange = useCallback(
    async (tone: FormattingSlackTone) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { slack: { tone } }) : old,
      );
      const ok = await setFormattingSlackTone(tone);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [mergeFormatting, queryClient],
  );

  const handleFormattingSlackAllowEmojiToggle = useCallback(async () => {
    const newValue = !formatting.slack.allowEmoji;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { slack: { allowEmoji: newValue } }) : old,
    );
    const ok = await setFormattingSlackAllowEmoji(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.slack.allowEmoji, mergeFormatting, queryClient]);

  const handleFormattingSlackUseMarkdownToggle = useCallback(async () => {
    const newValue = !formatting.slack.useMarkdown;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { slack: { useMarkdown: newValue } }) : old,
    );
    const ok = await setFormattingSlackUseMarkdown(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.slack.useMarkdown, mergeFormatting, queryClient]);

  const handleFormattingSlackLightweightToggle = useCallback(async () => {
    const newValue = !formatting.slack.lightweight;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { slack: { lightweight: newValue } }) : old,
    );
    const ok = await setFormattingSlackLightweight(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.slack.lightweight, mergeFormatting, queryClient]);

  const handleDocumentToneChange = useCallback(
    async (tone: FormattingDocumentTone) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { document: { tone } }) : old,
      );
      const ok = await setFormattingDocumentTone(tone);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [mergeFormatting, queryClient],
  );

  const handleDocumentStructureChange = useCallback(
    async (structure: FormattingDocumentStructure) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { document: { structure } }) : old,
      );
      const ok = await setFormattingDocumentStructure(structure);
      if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
    },
    [mergeFormatting, queryClient],
  );

  const handleFormattingDocumentLightweightToggle = useCallback(async () => {
    const newValue = !formatting.document.lightweight;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { document: { lightweight: newValue } }) : old,
    );
    const ok = await setFormattingDocumentLightweight(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.document.lightweight, mergeFormatting, queryClient]);

  const handleFormattingEmailIncludeSenderNameToggle = useCallback(async () => {
    const newValue = !formatting.email.includeSenderName;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? mergeFormatting(old, { email: { includeSenderName: newValue } })
        : old,
    );
    const ok = await setFormattingEmailIncludeSenderName(newValue);
    if (!ok) queryClient.setQueryData(["settings"], await fetchSettings());
  }, [formatting.email.includeSenderName, mergeFormatting, queryClient]);

  return (
    <>
      <div className="mb-6">
        <h2 className="text-[28px] tracking-tight text-overlay/90">
          Auto-polish
        </h2>
        <p className="mt-3 text-[14px] text-overlay/44 leading-relaxed font-sans font-normal">
          Automatically cleans up your dictation based on which app you're in.
        </p>
      </div>

      {/* Platform warning */}
      {!formatting.available && (
        <div className="mb-6 rounded-xl border border-overlay/10 bg-surface-1 px-4 py-3.5">
          <p className="text-[14px] text-overlay/44 leading-relaxed font-sans">
            Auto-polish requires the vendored llama-cli binary, which is
            missing. Run{" "}
            <span className="text-overlay/62 font-medium">
              bun scripts/pre-build.ts
            </span>{" "}
            and relaunch on{" "}
            <span className="text-overlay/62 font-medium">
              {platformDisplayName(settings.capabilities.platform)}
            </span>
            .
          </p>
        </div>
      )}

      {/* Force mode alert */}
      <AnimatePresence>
        {formatting.forceModeId !== null && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent-amber/25 bg-accent-amber/8 px-4 py-3">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-accent-amber/90"
              >
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
              <span className="flex-1 text-[13px] text-overlay/72 leading-snug">
                Force mode active:{" "}
                <span className="font-medium text-accent-amber/90">
                  {formattingModeLabel(formatting.forceModeId)}
                </span>{" "}
                -- always applied, even if auto-polish is off or the format is
                disabled below. Clear to return to auto-detection.
              </span>
              <button
                onClick={() => void handleClearFormattingForce()}
                className="shrink-0 rounded-lg border border-overlay/14 bg-surface-2 px-3 py-1.5 text-[15px] font-medium text-overlay/72 hover:bg-surface-3 hover:text-overlay/90 transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Model tier picker */}
      {formatting.available && (
        <div className="mb-8">
          <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
            Model
          </h2>
          <div className="flex flex-col gap-2">
            {(
              [
                {
                  tier: "fast" as FormatterModelTier,
                  label: "Fast",
                  model: "Qwen2.5 3B",
                  size: "~2 GB",
                  desc: "Quicker, slightly less polished",
                },
                {
                  tier: "quality" as FormatterModelTier,
                  label: "Quality",
                  model: "Qwen3 4B",
                  size: "~2.5 GB",
                  desc: "Best results, bit slower",
                },
              ] as const
            ).map(({ tier, label, model, size, desc }) => {
              const isSelected = formatting.formatterModelTier === tier;
              const isInstalled = formatting.modelAvailability[tier];
              const dl = tierDownloads[tier];
              const isDownloading = dl.inFlight;
              const needsDownload = !isInstalled && !isDownloading;
              const canSelect = !isSelected && isInstalled;
              return (
                <div
                  key={tier}
                  className={`rounded-xl border transition-colors duration-200 overflow-hidden ${
                    isSelected
                      ? "border-accent-blue/25 bg-surface-2"
                      : "border-overlay/11 bg-surface-1"
                  } ${canSelect ? "hover:border-overlay/16 hover:bg-surface-2 cursor-pointer" : ""}`}
                  onClick={() => {
                    if (canSelect) void handleFormatterModelTierChange(tier);
                  }}
                >
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`text-[16px] font-semibold ${isSelected ? "text-overlay/85" : "text-overlay/60"}`}
                        >
                          {label}
                        </span>
                        {isSelected && isInstalled && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent-blue/15 text-accent-blue/80 border border-accent-blue/20">
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Active
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[13px] text-overlay/38">
                        {model} - {desc}
                      </p>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="text-[12px] text-overlay/25 tabular-nums">
                        {size}
                      </span>
                      {needsDownload && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownloadFormatterModel(tier);
                          }}
                          className="px-2.5 py-1 rounded-lg text-[12px] font-medium border border-overlay/12 hover:border-overlay/22 bg-surface-1 hover:bg-surface-3 text-overlay/48 hover:text-overlay/68 transition-colors duration-200 cursor-pointer"
                        >
                          Download
                        </button>
                      )}
                      {isInstalled && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteFormatterModel(tier);
                          }}
                          className="px-2.5 py-1 rounded-lg text-[12px] font-medium border border-accent-red/30 bg-accent-red/8 text-accent-red/70 hover:border-accent-red/40 hover:bg-accent-red/14 hover:text-accent-red/90 transition-colors duration-200 cursor-pointer"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>

                  {isDownloading && (
                    <div className="px-4 pb-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[12px] text-overlay/30 tabular-nums">
                          {Math.round(dl.fraction * 100)}%
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelFormatterDownload();
                          }}
                          className="text-[12px] font-medium text-overlay/28 hover:text-overlay/50 transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                      <div className="h-1 rounded-full bg-surface-3 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-accent-blue/40"
                          initial={{ width: 0 }}
                          animate={{
                            width: `${Math.round(dl.fraction * 100)}%`,
                          }}
                          transition={{ duration: 0.2 }}
                        />
                      </div>
                    </div>
                  )}

                  {dl.error && (
                    <div className="px-4 pb-3">
                      <span className="text-[13px] text-rose-300/80">
                        {dl.error}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className={settingsHelperClass}>
            The on-device model that rewrites your dictation. Set once; the
            active tier applies to all formats below.
          </p>
        </div>
      )}

      {/* Modes accordion */}
      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Formats
        </h2>
        <div className="flex flex-col gap-2">
          {FORMATTING_MODES.map((mode) => {
            const enabled = formatting.enabledModes[mode.id] ?? false;
            const isExpanded = expandedMode === mode.id;
            const isLightweight =
              (mode.id === "imessage" && formatting.imessage.lightweight) ||
              (mode.id === "slack" && formatting.slack.lightweight) ||
              (mode.id === "document" && formatting.document.lightweight);

            return (
              <div
                key={mode.id}
                className={`rounded-xl border transition-colors duration-200 ${
                  isExpanded
                    ? "border-accent-blue/25 bg-surface-2"
                    : "border-overlay/11 bg-surface-1 overflow-hidden"
                }`}
              >
                {/* Collapsed row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setExpandedMode(isExpanded ? null : mode.id)}
                    className="flex flex-1 items-center gap-3 min-w-0 cursor-pointer"
                  >
                    <div
                      className={`shrink-0 ${isExpanded || enabled ? "text-overlay/60" : "text-overlay/30"}`}
                    >
                      {MODE_ICONS[mode.id]}
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[16px] font-semibold ${
                            isExpanded || enabled
                              ? "text-overlay/85"
                              : "text-overlay/55"
                          }`}
                        >
                          {mode.label}
                        </span>
                        {isLightweight && enabled && (
                          <span className="rounded-md border border-overlay/12 bg-surface-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-overlay/40">
                            Light
                          </span>
                        )}
                      </div>
                      <span className="text-[13px] text-overlay/38">
                        {MODE_DESCRIPTIONS[mode.id]}
                      </span>
                    </div>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`shrink-0 text-overlay/30 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  <Switch
                    checked={enabled}
                    onCheckedChange={() =>
                      void handleFormattingModeToggle(mode.id)
                    }
                    aria-label={`Toggle ${mode.label} auto-polish`}
                  />
                </div>

                {/* Expanded settings */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, overflow: "hidden" }}
                      animate={{
                        height: "auto",
                        opacity: 1,
                        overflow: "visible",
                      }}
                      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
                      transition={{ duration: 0.2, overflow: { delay: 0.2 } }}
                    >
                      <div className="border-t border-overlay/8 px-4 pt-3 pb-4">
                        {mode.id === "email" && (
                          <EmailSettings
                            formatting={formatting}
                            customGreetingDraft={customGreetingDraft}
                            customClosingDraft={customClosingDraft}
                            onCustomGreetingChange={setCustomGreetingDraft}
                            onCustomGreetingCommit={handleCustomGreetingCommit}
                            onCustomClosingChange={setCustomClosingDraft}
                            onCustomClosingCommit={handleCustomClosingCommit}
                            onGreetingStyleChange={
                              handleEmailGreetingStyleChange
                            }
                            onClosingStyleChange={handleEmailClosingStyleChange}
                            onIncludeSenderNameToggle={
                              handleFormattingEmailIncludeSenderNameToggle
                            }
                          />
                        )}
                        {mode.id === "imessage" && (
                          <ImessageSettings
                            formatting={formatting}
                            onToneChange={handleImessageToneChange}
                            onLightweightToggle={
                              handleFormattingImessageLightweightToggle
                            }
                            onAllowEmojiToggle={
                              handleFormattingImessageAllowEmojiToggle
                            }
                          />
                        )}
                        {mode.id === "slack" && (
                          <SlackSettings
                            formatting={formatting}
                            onToneChange={handleSlackToneChange}
                            onLightweightToggle={
                              handleFormattingSlackLightweightToggle
                            }
                            onUseMarkdownToggle={
                              handleFormattingSlackUseMarkdownToggle
                            }
                            onAllowEmojiToggle={
                              handleFormattingSlackAllowEmojiToggle
                            }
                          />
                        )}
                        {mode.id === "document" && (
                          <DocumentSettings
                            formatting={formatting}
                            onToneChange={handleDocumentToneChange}
                            onStructureChange={handleDocumentStructureChange}
                            onLightweightToggle={
                              handleFormattingDocumentLightweightToggle
                            }
                          />
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function EmailSettings({
  formatting,
  customGreetingDraft,
  customClosingDraft,
  onCustomGreetingChange,
  onCustomGreetingCommit,
  onCustomClosingChange,
  onCustomClosingCommit,
  onGreetingStyleChange,
  onClosingStyleChange,
  onIncludeSenderNameToggle,
}: {
  formatting: AppSettings["formatting"];
  customGreetingDraft: string;
  customClosingDraft: string;
  onCustomGreetingChange: (v: string) => void;
  onCustomGreetingCommit: () => Promise<void>;
  onCustomClosingChange: (v: string) => void;
  onCustomClosingCommit: () => Promise<void>;
  onGreetingStyleChange: (s: FormattingEmailGreetingStyle) => void;
  onClosingStyleChange: (s: FormattingEmailClosingStyle) => void;
  onIncludeSenderNameToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-overlay/8 bg-surface-1 overflow-hidden">
        <SwitchRow
          label="Add my name to email sign-off"
          description="Uses your stored name when the email needs a sign-off and you did not dictate one clearly."
          checked={formatting.email.includeSenderName}
          onCheckedChange={onIncludeSenderNameToggle}
          ariaLabel="Toggle sender name in email sign-off"
        />
      </div>

      <div>
        <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
          Greeting style
        </span>
        <DropdownPicker
          value={formatting.email.greetingStyle}
          onChange={onGreetingStyleChange}
          options={EMAIL_GREETING_OPTIONS}
          ariaLabel="Preferred email greeting style"
        />
        <AnimatePresence>
          {formatting.email.greetingStyle === "custom" && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <input
                type="text"
                value={customGreetingDraft}
                onChange={(e) => onCustomGreetingChange(e.target.value)}
                onBlur={() => void onCustomGreetingCommit()}
                placeholder="e.g. Dear"
                className="mt-3 w-full rounded-lg border border-overlay/12 bg-surface-1 px-3 py-2.5 text-[15px] font-medium text-overlay/78 outline-none transition-[border-color,background-color] duration-200 placeholder:text-overlay/24 hover:border-overlay/18 focus-visible:border-overlay/26 focus-visible:ring-2 focus-visible:ring-overlay/12 focus-visible:ring-offset-0"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div>
        <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
          Closing style
        </span>
        <DropdownPicker
          value={formatting.email.closingStyle}
          onChange={onClosingStyleChange}
          options={EMAIL_CLOSING_OPTIONS}
          ariaLabel="Preferred email closing style"
        />
        <AnimatePresence>
          {formatting.email.closingStyle === "custom" && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <input
                type="text"
                value={customClosingDraft}
                onChange={(e) => onCustomClosingChange(e.target.value)}
                onBlur={() => void onCustomClosingCommit()}
                placeholder="e.g. Cheers"
                className="mt-3 w-full rounded-lg border border-overlay/12 bg-surface-1 px-3 py-2.5 text-[15px] font-medium text-overlay/78 outline-none transition-[border-color,background-color] duration-200 placeholder:text-overlay/24 hover:border-overlay/18 focus-visible:border-overlay/26 focus-visible:ring-2 focus-visible:ring-overlay/12 focus-visible:ring-offset-0"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <p className={`${settingsHelperClass} !mt-0`}>
        The formatter keeps your language and only fills in missing pieces like
        greeting, sign-off, and spacing.
      </p>
    </div>
  );
}

function ImessageSettings({
  formatting,
  onToneChange,
  onLightweightToggle,
  onAllowEmojiToggle,
}: {
  formatting: AppSettings["formatting"];
  onToneChange: (t: FormattingImessageTone) => void;
  onLightweightToggle: () => void;
  onAllowEmojiToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
          Tone
        </span>
        <TileGroup
          value={formatting.imessage.tone}
          onChange={onToneChange}
          options={IMESSAGE_TONE_OPTIONS}
          columns={3}
          ariaLabel="Messages tone"
        />
      </div>

      <div className="rounded-xl border border-overlay/8 bg-surface-1 overflow-hidden divide-y divide-overlay/8">
        <SwitchRow
          label="Light formatting only"
          description="Skips the LLM rewrite. Tidies spacing only; tone controls capitalization."
          checked={formatting.imessage.lightweight}
          onCheckedChange={onLightweightToggle}
          ariaLabel="Toggle lightweight Messages auto-polish"
        />
        <LightLockedShell
          locked={formatting.imessage.lightweight}
          hint={LIGHT_AI_LOCKED_HINT}
        >
          <SwitchRow
            label="Allow emoji"
            description="Lets Codictate sprinkle in a relevant emoji when it fits the mood."
            checked={formatting.imessage.allowEmoji}
            onCheckedChange={onAllowEmojiToggle}
            ariaLabel="Toggle Messages emoji"
          />
        </LightLockedShell>
      </div>

      <p className={`${settingsHelperClass} !mt-0`}>
        With light formatting, only spacing and tone-driven caps apply. With the
        LLM on, Formal means heavier polish, Casual a lighter touch.
      </p>
    </div>
  );
}

function SlackSettings({
  formatting,
  onToneChange,
  onLightweightToggle,
  onUseMarkdownToggle,
  onAllowEmojiToggle,
}: {
  formatting: AppSettings["formatting"];
  onToneChange: (t: FormattingSlackTone) => void;
  onLightweightToggle: () => void;
  onUseMarkdownToggle: () => void;
  onAllowEmojiToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
          Tone
        </span>
        <TileGroup
          value={formatting.slack.tone}
          onChange={onToneChange}
          options={SLACK_TONE_OPTIONS}
          columns={3}
          ariaLabel="Slack tone"
        />
      </div>

      <div className="rounded-xl border border-overlay/8 bg-surface-1 overflow-hidden divide-y divide-overlay/8">
        <SwitchRow
          label="Light formatting only"
          description="Skips the LLM rewrite. Tidies spacing; tone controls capitalization."
          checked={formatting.slack.lightweight}
          onCheckedChange={onLightweightToggle}
          ariaLabel="Toggle lightweight Slack auto-polish"
        />
        <LightLockedShell
          locked={formatting.slack.lightweight}
          hint={LIGHT_AI_LOCKED_HINT}
        >
          <div className="divide-y divide-overlay/8">
            <SwitchRow
              label="Use Slack markdown"
              description="Adds *bold*, _italic_, `code` and bullet lists when helpful."
              checked={formatting.slack.useMarkdown}
              onCheckedChange={onUseMarkdownToggle}
              ariaLabel="Toggle Slack markdown"
            />
            <SwitchRow
              label="Allow emoji"
              description="Slack-flavoured :thumbsup: style emoji where appropriate."
              checked={formatting.slack.allowEmoji}
              onCheckedChange={onAllowEmojiToggle}
              ariaLabel="Toggle Slack emoji"
            />
          </div>
        </LightLockedShell>
      </div>

      <p className={`${settingsHelperClass} !mt-0`}>
        With light formatting, only spacing and tone-driven caps apply. With the
        LLM on, Formal is a stronger polish, Casual a lighter touch.
      </p>
    </div>
  );
}

function DocumentSettings({
  formatting,
  onToneChange,
  onStructureChange,
  onLightweightToggle,
}: {
  formatting: AppSettings["formatting"];
  onToneChange: (t: FormattingDocumentTone) => void;
  onStructureChange: (s: FormattingDocumentStructure) => void;
  onLightweightToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
          Tone
        </span>
        <TileGroup
          value={formatting.document.tone}
          onChange={onToneChange}
          options={DOCUMENT_TONE_OPTIONS}
          columns={3}
          ariaLabel="Document tone"
        />
      </div>

      <div className="rounded-xl border border-overlay/8 bg-surface-1 overflow-hidden divide-y divide-overlay/8">
        <SwitchRow
          label="Light formatting only"
          description="Skips the LLM rewrite. Tidies spacing; tone controls capitalization."
          checked={formatting.document.lightweight}
          onCheckedChange={onLightweightToggle}
          ariaLabel="Toggle lightweight document auto-polish"
        />
      </div>

      <LightLockedShell
        locked={formatting.document.lightweight}
        hint={LIGHT_AI_LOCKED_HINT}
      >
        <div>
          <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
            Structure
          </span>
          <TileGroup
            value={formatting.document.structure}
            onChange={onStructureChange}
            options={DOCUMENT_STRUCTURE_OPTIONS}
            columns={2}
            ariaLabel="Document structure"
          />
        </div>
      </LightLockedShell>

      <p className={`${settingsHelperClass} !mt-0`}>
        With light formatting, only spacing and tone-driven caps apply. With the
        LLM on, Formal is a stronger polish, Casual a lighter touch.
      </p>
    </div>
  );
}

function DropdownChevron({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-overlay/45 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function DropdownPicker<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: TileOption<T>[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (val: T) => {
    onChange(val);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <motion.button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-overlay/11 bg-surface-1 px-4 py-2.5 text-left transition-colors duration-200 hover:border-overlay/16 hover:bg-surface-2"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-sans text-[14px] font-medium text-overlay/92">
            {selected.label}
          </span>
          {selected.sublabel && (
            <span className="mt-0.5 text-[12px] text-overlay/55">
              {selected.sublabel}
            </span>
          )}
        </div>
        <DropdownChevron open={open} />
      </motion.button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-overlay/12 bg-surface-elevated/98 shadow-[var(--popover-shadow)] ring-1 ring-overlay/8 backdrop-blur-md"
            role="listbox"
            aria-label={ariaLabel}
          >
            <div
              className="max-h-[min(340px,52vh)] overflow-y-auto overflow-x-hidden p-1 [scrollbar-gutter:stable]"
              style={{ scrollbarWidth: "thin" }}
            >
              <div className="flex flex-col gap-1">
                {options.map((opt) => {
                  const isActive = opt.value === value;
                  return (
                    <motion.button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => pick(opt.value)}
                      className={`relative flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors duration-200 ${
                        isActive
                          ? "border-overlay/26 bg-surface-2"
                          : "border-overlay/11 bg-transparent hover:border-overlay/16 hover:bg-surface-2"
                      }`}
                    >
                      <div
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                        style={{
                          borderColor: isActive
                            ? "var(--overlay-38)"
                            : "var(--overlay-18)",
                        }}
                      >
                        {isActive ? (
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{
                              type: "spring",
                              stiffness: 500,
                              damping: 25,
                            }}
                            className="h-2 w-2 rounded-full bg-overlay/60"
                          />
                        ) : null}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col text-left">
                        <span
                          className={`font-sans text-[14px] leading-snug transition-colors duration-200 ${
                            isActive
                              ? "text-overlay/92 font-medium"
                              : "text-overlay/72"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.sublabel && (
                          <span
                            className={`mt-0.5 text-[12px] transition-colors duration-200 ${
                              isActive ? "text-overlay/55" : "text-overlay/40"
                            }`}
                          >
                            {opt.sublabel}
                          </span>
                        )}
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const TILE_GRID_COLS: Record<number, string> = {
  2: "grid-cols-1 xl:grid-cols-2",
  3: "grid-cols-1 xl:grid-cols-3",
  4: "grid-cols-1 min-[520px]:grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-1 min-[520px]:grid-cols-2 xl:grid-cols-5",
};

function TileGroup<T extends string>({
  value,
  onChange,
  options,
  columns,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: TileOption<T>[];
  columns: number;
  ariaLabel?: string;
}) {
  const gridClass = TILE_GRID_COLS[columns] ?? "grid-cols-3";
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`grid ${gridClass} gap-4`}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={`flex h-full min-h-[220px] w-full flex-col text-left rounded-2xl border transition-all duration-200 cursor-pointer overflow-hidden hover:border-overlay/20 hover:bg-surface-2 ${
              selected
                ? "border-accent-blue/60 bg-surface-3 ring-1 ring-accent-blue/40 shadow-lg shadow-blue-500/10"
                : "border-overlay/11 bg-surface-1"
            }`}
          >
            <div className="p-5 pb-2">
              <span
                className={`block text-[26px] tracking-tight ${
                  opt.label === "Formal." ? "font-serif" : "font-sans"
                } ${selected ? "text-white" : "text-overlay/80"}`}
              >
                {opt.label}
              </span>
              {opt.sublabel && (
                <span
                  className={`mt-1 block text-[13px] font-medium ${
                    selected ? "text-overlay/60" : "text-overlay/40"
                  }`}
                >
                  {opt.sublabel}
                </span>
              )}
            </div>

            {opt.preview && (
              <div className="px-4 pb-5 mt-auto pt-6">
                <div
                  className={`rounded-2xl rounded-br-sm p-4 text-[15px] leading-relaxed whitespace-pre-wrap relative ${
                    selected
                      ? "bg-accent-blue/20 text-blue-50"
                      : "bg-surface-1 text-overlay/70"
                  }`}
                >
                  {opt.preview}
                </div>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
