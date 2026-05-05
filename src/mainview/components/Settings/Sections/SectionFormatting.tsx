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
  setFormattingEnabled,
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
  { value: "custom", label: "Custom…", sublabel: "You decide" },
  { value: "none", label: "None", sublabel: "Skip greeting entirely" },
];

const EMAIL_CLOSING_OPTIONS: TileOption<FormattingEmailClosingStyle>[] = [
  { value: "auto", label: "Auto", sublabel: "Let Codictate pick" },
  { value: "best-regards", label: "Best regards,", sublabel: "Professional" },
  { value: "thanks", label: "Thanks,", sublabel: "Grateful" },
  { value: "kind-regards", label: "Kind regards,", sublabel: "Warm" },
  { value: "custom", label: "Custom…", sublabel: "You decide" },
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
      "quick update — the new build is out, let me know if anything breaks",
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
      "So here's where we landed after the chat — a few things to lock in.",
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
      "• Design: UI pass this week\n• Engineering: API wrap-up\n• Review Friday",
  },
];

const LIGHT_AI_LOCKED_HINT =
  "These use the on-device LLM. Turn off light formatting above to change them.";

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
        <p className="px-4 pb-3.5 pt-0.5 text-[15px] text-white/44 leading-snug">
          {hint}
        </p>
      ) : null}
    </>
  );
}

type Props = {
  settings: AppSettings;
};

export function SectionFormatting({ settings }: Props) {
  const queryClient = useQueryClient();
  const formatting = settings.formatting;
  const [focusedFormat, setFocusedFormat] = useState<FormattingModeId>("email");
  const [customGreetingDraft, setCustomGreetingDraft] = useState("");
  const [customClosingDraft, setCustomClosingDraft] = useState("");
  const [modelDownload, setModelDownload] = useState<{
    inFlight: boolean;
    fraction: number;
    error?: string;
  }>({ inFlight: false, fraction: 0 });

  useEffect(() => {
    return appEvents.on("formatterModelProgress", (data) => {
      setModelDownload({
        inFlight: !data.done,
        fraction: data.progressFraction,
        error: data.error,
      });
    });
  }, []);

  const handleDownloadFormatterModel = useCallback(() => {
    setModelDownload({ inFlight: true, fraction: 0 });
    downloadFormatterModel();
  }, []);

  const handleCancelFormatterDownload = useCallback(() => {
    cancelFormatterModelDownload();
    setModelDownload({ inFlight: false, fraction: 0 });
  }, []);

  const handleDeleteFormatterModel = useCallback(() => {
    deleteFormatterModel();
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
          ? {
              email: {
                ...old.formatting.email,
                ...patch.email,
              },
            }
          : {}),
        ...(patch.imessage
          ? {
              imessage: {
                ...old.formatting.imessage,
                ...patch.imessage,
              },
            }
          : {}),
        ...(patch.slack
          ? {
              slack: {
                ...old.formatting.slack,
                ...patch.slack,
              },
            }
          : {}),
        ...(patch.document
          ? {
              document: {
                ...old.formatting.document,
                ...patch.document,
              },
            }
          : {}),
      };

      return {
        ...old,
        formatting: nextFormatting,
      };
    },
    [],
  );

  const handleFormattingEnabledToggle = useCallback(async () => {
    const newValue = !formatting.enabled;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? mergeFormatting(old, { enabled: newValue }) : old,
    );
    const ok = await setFormattingEnabled(newValue);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [formatting.enabled, mergeFormatting, queryClient]);

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
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
    },
    [mergeFormatting, queryClient],
  );

  const handleEmailClosingStyleChange = useCallback(
    async (style: FormattingEmailClosingStyle) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? mergeFormatting(old, { email: { closingStyle: style } }) : old,
      );
      const ok = await setFormattingEmailClosingStyle(style);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
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
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [formatting.email.includeSenderName, mergeFormatting, queryClient]);

  const effectiveFraction = modelDownload.inFlight
    ? modelDownload.fraction
    : formatting.modelInstalled
      ? 1
      : 0;

  return (
    <>
      {!formatting.available && (
        <div className="mb-6 rounded-xl border border-white/10 bg-white/4 px-4 py-3.5">
          <p className="text-[14px] text-white/44 leading-relaxed font-sans">
            Formatting requires the vendored llama-cli binary, which is missing.
            Run{" "}
            <span className="text-white/62 font-medium">
              bun scripts/pre-build.ts
            </span>{" "}
            and relaunch on{" "}
            <span className="text-white/62 font-medium">
              {platformDisplayName(settings.capabilities.platform)}
            </span>
            .
          </p>
        </div>
      )}

      {formatting.available && (
        <div className="mb-6 rounded-xl border border-white/11 bg-white/4 px-4 py-3.5">
          <span className="block text-[13px] font-medium text-white/86 mb-2.5">
            Formatter model
          </span>
          <div className="flex gap-2 mb-3">
            {(
              [
                {
                  tier: "fast" as FormatterModelTier,
                  label: "Qwen2.5 3B",
                  sublabel: "Fast · ~2 GB · multilingual",
                },
                {
                  tier: "quality" as FormatterModelTier,
                  label: "Qwen3 4B",
                  sublabel: "Better quality · ~2.5 GB · 119 languages",
                },
              ] as const
            ).map(({ tier, label, sublabel }) => {
              const active = formatting.formatterModelTier === tier;
              return (
                <button
                  key={tier}
                  onClick={() => handleFormatterModelTierChange(tier)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${
                    active
                      ? "border-blue-400/40 bg-blue-500/16 text-white"
                      : "border-white/12 bg-white/6 text-white/60 hover:bg-white/10 hover:text-white/80"
                  }`}
                >
                  <span className="block text-[15px] font-medium">{label}</span>
                  <span className="block text-[13px] mt-0.5 opacity-70">
                    {sublabel}
                  </span>
                </button>
              );
            })}
          </div>

          {!formatting.modelInstalled && (
            <div>
              <span className="block text-[15px] text-white/50 mb-2">
                {formatting.formatterModelTier === "fast"
                  ? "Qwen2.5 3B not downloaded yet."
                  : "Qwen3 4B not downloaded yet."}
              </span>
              {modelDownload.error && (
                <span className="mb-2 block text-[14px] text-rose-300/80">
                  {modelDownload.error}
                </span>
              )}
              {modelDownload.inFlight && (
                <div className="mb-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-blue-400 transition-all duration-150"
                    style={{ width: `${Math.round(effectiveFraction * 100)}%` }}
                  />
                </div>
              )}
              <div className="flex gap-2">
                {modelDownload.inFlight ? (
                  <button
                    onClick={handleCancelFormatterDownload}
                    className="rounded-lg border border-white/16 bg-white/8 px-3 py-1.5 text-[14px] text-white/80 hover:bg-white/12 cursor-pointer"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={handleDownloadFormatterModel}
                    className="rounded-lg border border-blue-400/40 bg-blue-500/20 px-3 py-1.5 text-[14px] text-white hover:bg-blue-500/30 cursor-pointer"
                  >
                    Download
                  </button>
                )}
              </div>
            </div>
          )}

          {formatting.modelInstalled && (
            <div className="flex items-center gap-2">
              <span className="text-[14px] text-emerald-400/80">
                ✓{" "}
                {formatting.formatterModelTier === "fast"
                  ? "Qwen2.5 3B"
                  : "Qwen3 4B"}{" "}
                installed
              </span>
              <button
                onClick={handleDeleteFormatterModel}
                className="ml-auto text-[13px] text-white/40 hover:text-white/70 cursor-pointer"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mb-6 rounded-xl border border-white/11 bg-white/4 px-4 py-3.5">
        <div className="flex items-center gap-3">
          {(() => {
            const effectiveOn =
              formatting.enabled || formatting.forceModeId !== null;
            return (
              <>
                <div className="flex-1 min-w-0">
                  <span
                    className={`block text-[17px] font-medium ${effectiveOn ? "text-white/86" : "text-white/60"}`}
                  >
                    Formatting
                  </span>
                  <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                    Auto-detects the focused app and applies the matching
                    format. Works in standard recording mode only — not stream
                    mode. Force mode (set from the tray) always applies
                    regardless of this switch.
                  </span>
                </div>
                <button
                  onClick={handleFormattingEnabledToggle}
                  disabled={!formatting.available || !formatting.modelInstalled}
                  className={`relative shrink-0 w-10 h-6 rounded-full transition-colors duration-200 cursor-pointer border disabled:cursor-not-allowed disabled:opacity-50 ${
                    effectiveOn
                      ? "border-blue-400/50 bg-white/10"
                      : "bg-white/7 border-white/14"
                  }`}
                  aria-label="Toggle formatting master switch"
                >
                  <span
                    className={`absolute top-px w-5 h-5 rounded-full transition-all duration-200 ${
                      effectiveOn
                        ? "left-[18px] bg-blue-400"
                        : "left-0.5 bg-white/40"
                    }`}
                  />
                </button>
              </>
            );
          })()}
        </div>
      </div>

      <AnimatePresence>
        {formatting.forceModeId !== null && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-amber-300/90"
              >
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
              <span className="flex-1 text-[13px] text-white/72 leading-snug">
                Force mode active:{" "}
                <span className="font-medium text-amber-200/90">
                  {formattingModeLabel(formatting.forceModeId)}
                </span>{" "}
                — always applied, even if formatting is off or the format is
                disabled below. Clear to return to auto-detection.
              </span>
              <button
                onClick={() => void handleClearFormattingForce()}
                className="shrink-0 rounded-lg border border-white/14 bg-white/6 px-3 py-1.5 text-[15px] font-medium text-white/72 hover:bg-white/10 hover:text-white/90 transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mb-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider">
            Formats
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-2.5 min-[520px]:grid-cols-2 xl:grid-cols-4">
          {FORMATTING_MODES.map((mode) => {
            const enabled = formatting.enabledModes[mode.id] ?? false;
            const focused = focusedFormat === mode.id;
            return (
              <div
                key={mode.id}
                className={`relative rounded-xl border transition-all duration-200 overflow-hidden ${
                  focused
                    ? "border-blue-400/50 bg-blue-400/5"
                    : enabled
                      ? "border-white/14 bg-white/6 hover:border-white/22"
                      : "border-white/10 bg-white/4 hover:border-white/18"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setFocusedFormat(mode.id)}
                  aria-pressed={focused}
                  className="w-full text-left px-4 pt-4 pb-12 cursor-pointer"
                >
                  <span
                    className={`block text-[15px] xl:text-[17px] font-medium ${
                      focused
                        ? "text-white/92"
                        : enabled
                          ? "text-white/82"
                          : "text-white/58"
                    }`}
                  >
                    {mode.label}
                  </span>
                  <span
                    className={`mt-1 block text-[15px] xl:text-[13px] leading-snug ${
                      focused ? "text-white/58" : "text-white/40"
                    }`}
                  >
                    {mode.tagline}
                  </span>
                  {(mode.id === "imessage" &&
                    formatting.imessage.lightweight) ||
                  (mode.id === "slack" && formatting.slack.lightweight) ||
                  (mode.id === "document" &&
                    formatting.document.lightweight) ? (
                    <span className="mt-2 inline-flex rounded-md border border-white/12 bg-white/5 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/48">
                      Light formatting
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => handleFormattingModeToggle(mode.id)}
                  aria-label={`Toggle ${mode.label} formatting`}
                  className={`absolute bottom-2 right-2 h-5 w-9 rounded-full border transition-colors duration-200 cursor-pointer ${
                    enabled
                      ? "border-blue-400/50 bg-white/10"
                      : "bg-white/7 border-white/14"
                  }`}
                >
                  <span
                    className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                      enabled ? "left-4 bg-blue-400" : "left-0.5 bg-white/40"
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {focusedFormat === "email" && (
        <div className="mb-8">
          <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
            Email behavior
          </h2>
          <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-1 min-w-0">
                <span
                  className={`block text-[17px] font-medium ${formatting.email.includeSenderName ? "text-white/78" : "text-white/58"}`}
                >
                  Add my name to email sign-off
                </span>
                <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                  Uses your stored name when the email needs a sign-off and you
                  did not dictate one clearly.
                </span>
              </div>
              <button
                onClick={handleFormattingEmailIncludeSenderNameToggle}
                className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                  formatting.email.includeSenderName
                    ? "border-blue-400/50 bg-white/10"
                    : "bg-white/7 border-white/14"
                }`}
                aria-label="Toggle sender name in email sign-off"
              >
                <span
                  className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                    formatting.email.includeSenderName
                      ? "left-4 bg-blue-400"
                      : "left-0.5 bg-white/40"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="mt-5">
            <span className="mb-2 block text-[13px] text-white/44 font-sans">
              Greeting style
            </span>
            <DropdownPicker
              value={formatting.email.greetingStyle}
              onChange={handleEmailGreetingStyleChange}
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
                    onChange={(e) => setCustomGreetingDraft(e.target.value)}
                    onBlur={() => void handleCustomGreetingCommit()}
                    placeholder="e.g. Dear"
                    className="mt-3 w-full rounded-lg border border-white/12 bg-white/5 px-3 py-2.5 text-[15px] font-medium text-white/78 outline-none transition-[border-color,background-color] duration-200 placeholder:text-white/24 hover:border-white/18 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-5">
            <span className="mb-2 block text-[13px] text-white/44 font-sans">
              Closing style
            </span>
            <DropdownPicker
              value={formatting.email.closingStyle}
              onChange={handleEmailClosingStyleChange}
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
                    onChange={(e) => setCustomClosingDraft(e.target.value)}
                    onBlur={() => void handleCustomClosingCommit()}
                    placeholder="e.g. Cheers"
                    className="mt-3 w-full rounded-lg border border-white/12 bg-white/5 px-3 py-2.5 text-[15px] font-medium text-white/78 outline-none transition-[border-color,background-color] duration-200 placeholder:text-white/24 hover:border-white/18 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <p className={settingsHelperClass}>
            Applies in Mail, Outlook, Spark, Superhuman and Mimestream. The
            formatter keeps your language and only fills in missing pieces like
            greeting, sign-off, and spacing.
          </p>
        </div>
      )}

      {focusedFormat === "imessage" && (
        <div className="mb-8">
          <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
            Messages behavior
          </h2>
          <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden divide-y divide-white/8">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-1 min-w-0">
                <span
                  className={`block text-[17px] font-medium ${formatting.imessage.lightweight ? "text-white/78" : "text-white/58"}`}
                >
                  Light formatting only
                </span>
                <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                  Skips the LLM rewrite for Messages. Tidies spacing only; tone
                  below then controls capitalization (Very casual = lowercase).
                  Turn off for emoji and fuller rewrites.
                </span>
              </div>
              <button
                onClick={handleFormattingImessageLightweightToggle}
                className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                  formatting.imessage.lightweight
                    ? "border-blue-400/50 bg-white/10"
                    : "bg-white/7 border-white/14"
                }`}
                aria-label="Toggle lightweight Messages formatting"
              >
                <span
                  className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                    formatting.imessage.lightweight
                      ? "left-4 bg-blue-400"
                      : "left-0.5 bg-white/40"
                  }`}
                />
              </button>
            </div>
            <LightLockedShell
              locked={formatting.imessage.lightweight}
              hint={LIGHT_AI_LOCKED_HINT}
            >
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="flex-1 min-w-0">
                  <span
                    className={`block text-[17px] font-medium ${formatting.imessage.allowEmoji ? "text-white/78" : "text-white/58"}`}
                  >
                    Allow emoji
                  </span>
                  <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                    Lets Codictate sprinkle in a relevant emoji when it fits the
                    mood.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleFormattingImessageAllowEmojiToggle}
                  className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                    formatting.imessage.allowEmoji
                      ? "border-blue-400/50 bg-white/10"
                      : "bg-white/7 border-white/14"
                  }`}
                  aria-label="Toggle Messages emoji"
                >
                  <span
                    className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                      formatting.imessage.allowEmoji
                        ? "left-4 bg-blue-400"
                        : "left-0.5 bg-white/40"
                    }`}
                  />
                </button>
              </div>
            </LightLockedShell>
          </div>
          <div className="mt-5">
            <span className="mb-2 block text-[13px] text-white/44 font-sans">
              Tone
            </span>
            <TileGroup
              value={formatting.imessage.tone}
              onChange={handleImessageToneChange}
              options={IMESSAGE_TONE_OPTIONS}
              columns={3}
              ariaLabel="Messages tone"
            />
          </div>
          <p className={settingsHelperClass}>
            Applies in the Messages app. With light formatting only, only
            spacing and tone-driven caps apply. With the LLM on, Formal means
            heavier polish, Casual a lighter touch, and Very casual the smallest
            rewrite.
          </p>
        </div>
      )}

      {focusedFormat === "slack" && (
        <div className="mb-8">
          <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
            Slack behavior
          </h2>
          <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden divide-y divide-white/8">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-1 min-w-0">
                <span
                  className={`block text-[17px] font-medium ${formatting.slack.lightweight ? "text-white/78" : "text-white/58"}`}
                >
                  Light formatting only
                </span>
                <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                  Skips the LLM rewrite for Slack. Tidies spacing; tone below
                  then controls capitalization when Very casual is selected.
                  Turn off for markdown, emoji, and fuller rewrites.
                </span>
              </div>
              <button
                onClick={handleFormattingSlackLightweightToggle}
                className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                  formatting.slack.lightweight
                    ? "border-blue-400/50 bg-white/10"
                    : "bg-white/7 border-white/14"
                }`}
                aria-label="Toggle lightweight Slack formatting"
              >
                <span
                  className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                    formatting.slack.lightweight
                      ? "left-4 bg-blue-400"
                      : "left-0.5 bg-white/40"
                  }`}
                />
              </button>
            </div>
            <LightLockedShell
              locked={formatting.slack.lightweight}
              hint={LIGHT_AI_LOCKED_HINT}
            >
              <div className="divide-y divide-white/8">
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <div className="flex-1 min-w-0">
                    <span
                      className={`block text-[17px] font-medium ${formatting.slack.useMarkdown ? "text-white/78" : "text-white/58"}`}
                    >
                      Use Slack markdown
                    </span>
                    <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                      Adds{" "}
                      <span className="text-[16px] font-normal [font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe_UI',Roboto,'Helvetica_Neue',Arial,sans-serif]">
                        *bold*, _italic_, `code`
                      </span>{" "}
                      and bullet lists when helpful.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleFormattingSlackUseMarkdownToggle}
                    className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                      formatting.slack.useMarkdown
                        ? "border-blue-400/50 bg-white/10"
                        : "bg-white/7 border-white/14"
                    }`}
                    aria-label="Toggle Slack markdown"
                  >
                    <span
                      className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                        formatting.slack.useMarkdown
                          ? "left-4 bg-blue-400"
                          : "left-0.5 bg-white/40"
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <div className="flex-1 min-w-0">
                    <span
                      className={`block text-[17px] font-medium ${formatting.slack.allowEmoji ? "text-white/78" : "text-white/58"}`}
                    >
                      Allow emoji
                    </span>
                    <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                      Slack-flavoured :thumbsup: style emoji where appropriate.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleFormattingSlackAllowEmojiToggle}
                    className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                      formatting.slack.allowEmoji
                        ? "border-blue-400/50 bg-white/10"
                        : "bg-white/7 border-white/14"
                    }`}
                    aria-label="Toggle Slack emoji"
                  >
                    <span
                      className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                        formatting.slack.allowEmoji
                          ? "left-4 bg-blue-400"
                          : "left-0.5 bg-white/40"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </LightLockedShell>
          </div>
          <div className="mt-5">
            <span className="mb-2 block text-[13px] text-white/44 font-sans">
              Tone
            </span>
            <TileGroup
              value={formatting.slack.tone}
              onChange={handleSlackToneChange}
              options={SLACK_TONE_OPTIONS}
              columns={3}
              ariaLabel="Slack tone"
            />
          </div>
          <p className={settingsHelperClass}>
            Applies in the Slack desktop app. With light formatting, only
            spacing and tone-driven caps apply. With the LLM on, Formal is a
            stronger polish, Casual a lighter touch, and Very casual the
            smallest rewrite.
          </p>
        </div>
      )}

      {focusedFormat === "document" && (
        <div className="mb-8">
          <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
            Document behavior
          </h2>
          <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden divide-y divide-white/8">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-1 min-w-0">
                <span
                  className={`block text-[17px] font-medium ${formatting.document.lightweight ? "text-white/78" : "text-white/58"}`}
                >
                  Light formatting only
                </span>
                <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                  Skips the LLM rewrite for document apps. Tidies spacing; tone
                  below then controls capitalization when Very casual is
                  selected. Turn off for structure choices and fuller rewrites.
                </span>
              </div>
              <button
                type="button"
                onClick={handleFormattingDocumentLightweightToggle}
                className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                  formatting.document.lightweight
                    ? "border-blue-400/50 bg-white/10"
                    : "bg-white/7 border-white/14"
                }`}
                aria-label="Toggle lightweight document formatting"
              >
                <span
                  className={`absolute top-px w-4 h-4 rounded-full transition-all duration-200 ${
                    formatting.document.lightweight
                      ? "left-4 bg-blue-400"
                      : "left-0.5 bg-white/40"
                  }`}
                />
              </button>
            </div>
          </div>
          <div className="mt-5">
            <span className="mb-2 block text-[13px] text-white/44 font-sans">
              Tone
            </span>
            <TileGroup
              value={formatting.document.tone}
              onChange={handleDocumentToneChange}
              options={DOCUMENT_TONE_OPTIONS}
              columns={3}
              ariaLabel="Document tone"
            />
          </div>
          <div className="mt-5">
            <span className="mb-2 block text-[13px] text-white/44 font-sans">
              Structure
            </span>
            <LightLockedShell
              locked={formatting.document.lightweight}
              hint={LIGHT_AI_LOCKED_HINT}
            >
              <div className="px-1 pb-1 pt-0.5 sm:px-2">
                <TileGroup
                  value={formatting.document.structure}
                  onChange={handleDocumentStructureChange}
                  options={DOCUMENT_STRUCTURE_OPTIONS}
                  columns={2}
                  ariaLabel="Document structure"
                />
              </div>
            </LightLockedShell>
          </div>
          <p className={settingsHelperClass}>
            Applies in Notes, Pages, Word and similar writing apps. With light
            formatting, only spacing and tone-driven caps apply. With Apple
            Intelligence on, Formal is a stronger polish, Casual a lighter
            touch, and Very casual the smallest rewrite.
          </p>
        </div>
      )}
    </>
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
      className={`shrink-0 text-white/45 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
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
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-white/11 bg-white/4 px-4 py-3 text-left transition-colors duration-200 hover:border-white/16 hover:bg-white/6"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-sans text-[15px] font-medium text-white/92 xl:text-[17px]">
            {selected.label}
          </span>
          {selected.sublabel && (
            <span className="mt-0.5 text-[15px] text-white/55 xl:text-[13px]">
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
            className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-white/12 bg-[#141416]/98 shadow-[0_16px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/8 backdrop-blur-md"
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
                          ? "border-white/26 bg-white/6"
                          : "border-white/11 bg-transparent hover:border-white/16 hover:bg-white/6"
                      }`}
                    >
                      <div
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                        style={{
                          borderColor: isActive
                            ? "rgba(255,255,255,0.38)"
                            : "rgba(255,255,255,0.18)",
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
                            className="h-2 w-2 rounded-full bg-white/60"
                          />
                        ) : null}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col text-left">
                        <span
                          className={`font-sans text-[15px] leading-snug transition-colors duration-200 xl:text-[17px] ${
                            isActive
                              ? "text-white/92 font-medium"
                              : "text-white/72"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.sublabel && (
                          <span
                            className={`mt-0.5 text-[15px] transition-colors duration-200 xl:text-[13px] ${
                              isActive ? "text-white/55" : "text-white/40"
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
            className={`flex h-full min-h-[220px] w-full flex-col text-left rounded-2xl border transition-all duration-200 cursor-pointer overflow-hidden hover:border-white/20 hover:bg-white/6 ${
              selected
                ? "border-blue-400/60 bg-white/10 ring-1 ring-blue-400/40 shadow-lg shadow-blue-500/10"
                : "border-white/11 bg-white/4"
            }`}
          >
            <div className="p-5 pb-2">
              <span
                className={`block text-[26px] tracking-tight ${
                  opt.label === "Formal." ? "font-serif" : "font-sans"
                } ${selected ? "text-white" : "text-white/80"}`}
              >
                {opt.label}
              </span>
              {opt.sublabel && (
                <span
                  className={`mt-1 block text-[13px] font-medium ${
                    selected ? "text-white/60" : "text-white/40"
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
                      ? "bg-blue-500/20 text-blue-50"
                      : "bg-white/5 text-white/70"
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
