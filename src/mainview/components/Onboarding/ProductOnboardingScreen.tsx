"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { Switch } from "../Common/Switch";
import type {
  AppSettings,
  AppStatus,
  RecordingIndicatorMode,
  ShortcutId,
} from "../../../shared/types";
import {
  type OnboardingWritingStyle,
  formattingTonesFromOnboardingStyle,
} from "../../../shared/formatting-modes";
import { shortcutDisplayKeys } from "../../../shared/shortcut-options";
import {
  completeOnboarding,
  setOnboardingIndicatorPreview,
  setRecordingIndicatorMode,
  setShortcut,
  setTranscriptionLanguage,
  setTranslateDefaultLanguage,
  setUserDisplayName,
  setFormattingEmailGreetingStyle,
  setFormattingEmailClosingStyle,
  setFormattingImessageTone,
  setFormattingImessageAllowEmoji,
  setFormattingImessageLightweight,
  setFormattingSlackTone,
  setFormattingSlackAllowEmoji,
  setFormattingSlackLightweight,
  setFormattingDocumentTone,
  setFormattingDocumentLightweight,
} from "../../rpc";
import { appEvents } from "../../app-events";
import {
  WordmarkCodictate,
  wordmarkCodictateTypographyClass,
} from "../Brand/WordmarkCodictate";
import { ShortcutPicker } from "../Settings/ShortcutPicker";
import { LanguagePicker } from "../Settings/LanguagePicker";
import { RecordingOrb } from "../Common/RecordingOrb";
import { DictationShortcutStartHint } from "../Common/DictationShortcutStartHint";
import { Kbd } from "../Common/Kbd";
import { WindowTitleBar } from "../Common/WindowTitleBar";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

type Step = 0 | 1 | 2 | 3 | 4 | 5;

const WRITING_STYLE_OPTIONS: readonly {
  id: OnboardingWritingStyle;
  label: string;
  sublabel: string;
  preview: string;
}[] = [
  {
    id: "formal",
    label: "Formal.",
    sublabel: "Caps + Punctuation",
    preview:
      "Hey, are you free for lunch tomorrow? Let's do 12 if that works for you.",
  },
  {
    id: "natural",
    label: "Casual",
    sublabel: "Caps + Less punctuation",
    preview:
      "Hey are you free for lunch tomorrow? Let's do 12 if that works for you",
  },
  {
    id: "casual",
    label: "very casual",
    sublabel: "No Caps + Less punctuation",
    preview:
      "hey are you free for lunch tomorrow? let's do 12 if that works for you",
  },
] as const;

const INDICATOR_ONBOARDING_OPTIONS: readonly {
  mode: RecordingIndicatorMode;
  label: string;
  hint: string;
}[] = [
  {
    mode: "always",
    label: "Always on",
    hint: "Stays in the corner; subtle while idle, active while you dictate.",
  },
  {
    mode: "when-active",
    label: "Only while dictating",
    hint: "Shows while you are recording or transcribing, then hides.",
  },
  {
    mode: "off",
    label: "Off",
    hint: "No floating indicator on the desktop.",
  },
] as const;

/** Concrete language for translate-default picker (never `auto`). */
function initialTranslateDefaultDraft(s: AppSettings): string {
  if (s.translateDefaultLanguageId !== "auto") {
    return s.translateDefaultLanguageId;
  }
  if (s.transcriptionLanguageId !== "auto") {
    return s.transcriptionLanguageId;
  }
  return "en";
}

export function ProductOnboardingScreen({
  settings,
}: {
  settings: AppSettings;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(0);
  const [nameDraft, setNameDraft] = useState<string>(settings.userDisplayName);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutId>(
    settings.shortcutId,
  );
  const [languageDraft, setLanguageDraft] = useState(() =>
    initialTranslateDefaultDraft(settings),
  );
  const [status, setStatus] = useState<AppStatus>("ready");
  const [busy, setBusy] = useState(false);
  const [dictationTrialComplete, setDictationTrialComplete] = useState(false);
  const [indicatorDraft, setIndicatorDraft] =
    useState<RecordingIndicatorMode>("always");
  const [writingStyleDraft, setWritingStyleDraft] =
    useState<OnboardingWritingStyle>("natural");
  const [emojiDraft, setEmojiDraft] = useState(false);
  const dictationEngagedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return appEvents.on("status", (s) => setStatus(s));
  }, []);

  const mergeSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      queryClient.setQueryData(
        ["settings"],
        (old: AppSettings | undefined) => ({
          ...(old ?? settings),
          ...patch,
        }),
      );
    },
    [queryClient, settings],
  );

  useEffect(() => {
    if (step === 0) {
      const t = window.setTimeout(() => nameInputRef.current?.focus(), 200);
      return () => window.clearTimeout(t);
    }
  }, [step]);

  useEffect(() => {
    if (step === 3) {
      dictationEngagedRef.current = false;
      setDictationTrialComplete(false);
      const t = window.setTimeout(() => textareaRef.current?.focus(), 200);
      return () => window.clearTimeout(t);
    }
  }, [step]);

  useEffect(() => {
    if (step !== 3 || dictationTrialComplete) return;
    if (status === "recording" || status === "transcribing") {
      dictationEngagedRef.current = true;
    } else if (status === "ready" && dictationEngagedRef.current) {
      setDictationTrialComplete(true);
    }
  }, [status, step, dictationTrialComplete]);

  useEffect(() => {
    if (step !== 4) {
      void setOnboardingIndicatorPreview({ active: false });
      return;
    }
    void setOnboardingIndicatorPreview({ active: true, mode: indicatorDraft });
  }, [step, indicatorDraft]);

  useEffect(() => {
    return () => {
      void setOnboardingIndicatorPreview({ active: false });
    };
  }, []);

  useEffect(() => {
    setShortcutDraft(settings.shortcutId);
  }, [settings.shortcutId]);

  const handleNameContinue = useCallback(async () => {
    setBusy(true);
    try {
      const normalized = nameDraft.trim();
      await setUserDisplayName(normalized);
      mergeSettings({ userDisplayName: normalized });
      setStep(1);
    } finally {
      setBusy(false);
    }
  }, [mergeSettings, nameDraft]);

  const handleNameSkip = useCallback(() => {
    setStep(1);
  }, []);

  const handleShortcutContinue = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await setShortcut(shortcutDraft);
      if (ok) {
        mergeSettings({ shortcutId: shortcutDraft });
        setStep(2);
      }
    } finally {
      setBusy(false);
    }
  }, [mergeSettings, shortcutDraft]);

  const handleLanguageContinue = useCallback(async () => {
    setBusy(true);
    try {
      const okDefault = await setTranslateDefaultLanguage(languageDraft);
      if (!okDefault) return;
      const okAuto = await setTranscriptionLanguage("auto");
      if (!okAuto) return;
      mergeSettings({
        translateDefaultLanguageId: languageDraft,
        transcriptionLanguageId: "auto",
      });
      setStep(3);
    } finally {
      setBusy(false);
    }
  }, [languageDraft, mergeSettings]);

  const handleTryDictationContinue = useCallback(() => {
    if (!dictationTrialComplete) return;
    setStep(4);
  }, [dictationTrialComplete]);

  const handleIndicatorContinue = useCallback(async () => {
    setBusy(true);
    try {
      const okMode = await setRecordingIndicatorMode(indicatorDraft);
      if (!okMode) return;
      mergeSettings({ recordingIndicatorMode: indicatorDraft });
      setStep(5);
    } finally {
      setBusy(false);
    }
  }, [mergeSettings, indicatorDraft]);

  const handleFinishOnboarding = useCallback(async () => {
    setBusy(true);
    try {
      const tones = formattingTonesFromOnboardingStyle(writingStyleDraft);
      const results = await Promise.all([
        setFormattingEmailGreetingStyle("auto"),
        setFormattingEmailClosingStyle("auto"),
        setFormattingImessageTone(tones.imessage),
        setFormattingSlackTone(tones.slack),
        setFormattingDocumentTone(tones.document),
        setFormattingImessageAllowEmoji(emojiDraft),
        setFormattingSlackAllowEmoji(emojiDraft),
        setFormattingImessageLightweight(true),
        setFormattingSlackLightweight(true),
        setFormattingDocumentLightweight(true),
      ]);
      if (results.some((ok) => !ok)) return;
      mergeSettings({
        formatting: {
          ...settings.formatting,
          email: {
            ...settings.formatting.email,
            greetingStyle: "auto",
            closingStyle: "auto",
          },
          imessage: {
            ...settings.formatting.imessage,
            tone: tones.imessage,
            allowEmoji: emojiDraft,
            lightweight: true,
          },
          slack: {
            ...settings.formatting.slack,
            tone: tones.slack,
            allowEmoji: emojiDraft,
            lightweight: true,
          },
          document: {
            ...settings.formatting.document,
            tone: tones.document,
            lightweight: true,
          },
        },
      });
      const ok = await completeOnboarding();
      if (ok) {
        mergeSettings({ onboardingCompleted: true });
      }
    } finally {
      setBusy(false);
    }
  }, [emojiDraft, mergeSettings, writingStyleDraft]);

  const displayKeys = useMemo(
    () => shortcutDisplayKeys(shortcutDraft),
    [shortcutDraft],
  );

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center overflow-y-auto bg-codictate-page px-6 py-10 text-white select-none sm:px-8 lg:px-12">
      <WindowTitleBar platform={settings.capabilities.platform} />
      <div className="mx-auto flex w-full max-w-[820px] flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE }}
          className="flex flex-col items-center mb-6"
        >
          <WordmarkCodictate
            as="h1"
            className={`text-[24px] ${wordmarkCodictateTypographyClass}`}
          />
          <p className="text-[14px] text-overlay/28 mt-1">Quick setup</p>
        </motion.div>

        <div className="flex gap-2 mb-6">
          {([0, 1, 2, 3, 4, 5] as const).map((i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-all duration-300 ${
                step === i
                  ? "w-8 bg-overlay/45"
                  : step > i
                    ? "w-1.5 bg-accent-emerald/50"
                    : "w-1.5 bg-overlay/10"
              }`}
            />
          ))}
        </div>

        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div
              key="s-name"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="w-full"
            >
              <p className="text-[16px] text-overlay/55 text-center mb-4 leading-snug">
                What should we call you?
              </p>
              <p className="text-[13px] text-overlay/38 text-center mb-5 leading-relaxed">
                We use your name to personalize formatted output — e.g. email
                sign-offs. You can change this anytime in settings.
              </p>
              <input
                ref={nameInputRef}
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) {
                    e.preventDefault();
                    void handleNameContinue();
                  }
                }}
                placeholder="Your name"
                autoCapitalize="words"
                autoComplete="name"
                className="w-full rounded-xl border border-overlay/12 bg-overlay/4 px-4 py-3.5 text-[17px] text-overlay/85 placeholder:text-overlay/25 outline-none focus-visible:border-overlay/22 focus-visible:ring-2 focus-visible:ring-overlay/10 select-text"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleNameContinue()}
                className="mt-5 w-full py-3 rounded-xl text-[15px] font-medium bg-overlay/12 hover:bg-overlay/18 border border-overlay/14 text-overlay/85 transition-colors disabled:opacity-40"
              >
                Continue
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleNameSkip}
                className="mt-2 w-full py-2 rounded-xl text-[16px] text-overlay/38 hover:text-overlay/55 transition-colors cursor-pointer"
              >
                Skip for now
              </button>
            </motion.div>
          )}

          {step === 1 && (
            <motion.div
              key="s0"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="w-full"
            >
              <p className="text-[16px] text-overlay/55 text-center mb-4 leading-snug">
                Choose a shortcut to dictate from any app.
              </p>
              <ShortcutPicker
                value={shortcutDraft}
                onChange={setShortcutDraft}
                platform={settings.capabilities.platform}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleShortcutContinue()}
                className="mt-5 w-full py-3 rounded-xl text-[15px] font-medium bg-overlay/12 hover:bg-overlay/18 border border-overlay/14 text-overlay/85 transition-colors disabled:opacity-40"
              >
                Continue
              </button>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="s1"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="w-full"
            >
              <p className="text-[16px] text-overlay/55 text-center mb-4 leading-snug">
                Choose your mother toungue language or leave it at English. This
                is the language which should be translted{" "}
                <span className="font-bold">from</span>, when you use "Translate
                Mode".
              </p>
              <p className="text-[16px] text-overlay/50 text-center mb-4 leading-relaxed">
                You can change this anytime in settings.
              </p>
              <LanguagePicker
                value={languageDraft}
                onChange={setLanguageDraft}
                excludeAuto
                ariaLabel="Default language for translate mode"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleLanguageContinue()}
                className="mt-5 w-full py-3 rounded-xl text-[15px] font-medium bg-overlay/12 hover:bg-overlay/18 border border-overlay/14 text-overlay/85 transition-colors disabled:opacity-40"
              >
                Continue
              </button>
            </motion.div>
          )}

          {step === 3 && (
            <motion.div
              key="s2"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="w-full flex flex-col items-center"
            >
              <p className="mb-3 text-center text-[16px] leading-snug text-overlay/55">
                Try dictation once to continue. Click in the box, use your
                shortcut to speak, then stop the same way when you are done.
              </p>
              <div className="mx-auto mb-4 flex w-full flex-col items-center gap-6">
                <div className="flex items-center gap-1.5">
                  {displayKeys.map((key, i) => (
                    <span
                      key={`onb-try-${i}-${key}`}
                      className="flex items-center gap-1.5"
                    >
                      {i > 0 && (
                        <span className="text-[18px] font-light text-overlay/42">
                          +
                        </span>
                      )}
                      <Kbd>{key}</Kbd>
                    </span>
                  ))}
                </div>
                <DictationShortcutStartHint align="center" />
              </div>
              <div className="mb-3 flex w-full justify-center">
                <div className="flex items-center gap-4">
                  <div className="flex h-20 shrink-0 items-center justify-center">
                    <RecordingOrb status={status} />
                  </div>
                  <span className="min-h-[1.35rem] text-center text-[13px] text-overlay/35 leading-snug">
                    {status === "recording" && "Listening…"}
                    {status === "transcribing" && "Transcribing…"}
                    {status === "ready" && "Idle"}
                  </span>
                </div>
              </div>

              <textarea
                ref={textareaRef}
                rows={6}
                placeholder="Your dictation appears here…"
                className="w-full rounded-xl border border-overlay/12 bg-overlay/4 px-4 py-3 text-[15px] text-overlay/85 placeholder:text-overlay/25 outline-none focus-visible:border-overlay/22 focus-visible:ring-2 focus-visible:ring-overlay/10 resize-y min-h-[140px] select-text"
              />

              {!dictationTrialComplete && (
                <p className="mt-4 text-center text-[16px] text-accent-amber/55 leading-snug">
                  Finish one dictation session (recording or transcribing, then
                  idle) to unlock the next step.
                </p>
              )}

              <button
                type="button"
                disabled={busy || !dictationTrialComplete}
                onClick={handleTryDictationContinue}
                className="mt-5 w-full py-3 rounded-xl text-[15px] font-medium bg-overlay/12 hover:bg-overlay/18 border border-overlay/14 text-overlay/85 transition-colors disabled:opacity-40"
              >
                Continue
              </button>
            </motion.div>
          )}

          {step === 4 && (
            <motion.div
              key="s3"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="w-full flex flex-col items-center"
            >
              <p className="mb-2 text-center text-[16px] leading-snug text-overlay/55">
                Desktop recording indicator
              </p>
              <p className="mb-5 text-center text-[13px] leading-snug text-overlay/38">
                The floating chip updates on your desktop as you choose — try
                each option. You can change this anytime in settings.
              </p>
              <div className="flex w-full flex-col gap-2">
                {INDICATOR_ONBOARDING_OPTIONS.map(({ mode, label, hint }) => {
                  const selected = indicatorDraft === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setIndicatorDraft(mode)}
                      className={`w-full text-left rounded-xl border px-4 py-3.5 transition-colors duration-200 cursor-pointer ${
                        selected
                          ? "border-overlay/22 bg-overlay/8"
                          : "border-overlay/11 bg-overlay/4 hover:border-overlay/16 hover:bg-overlay/6"
                      }`}
                    >
                      <span
                        className={`block text-[15px] font-medium ${selected ? "text-overlay/88" : "text-overlay/62"}`}
                      >
                        {label}
                      </span>
                      <span className="mt-0.5 block text-[16px] text-overlay/40 leading-snug">
                        {hint}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleIndicatorContinue()}
                className="mt-5 w-full py-3 rounded-xl text-[15px] font-medium bg-overlay/12 hover:bg-overlay/18 border border-overlay/14 text-overlay/85 transition-colors disabled:opacity-40"
              >
                Continue
              </button>
            </motion.div>
          )}

          {step === 5 && (
            <motion.div
              key="s-style"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex w-full flex-col items-stretch"
            >
              <p className="mb-2 text-center text-[16px] leading-snug text-overlay/55 sm:text-[17px]">
                How do you usually write?
              </p>
              <p className="mb-5 text-center text-[13px] leading-snug text-overlay/38 sm:text-[14px]">
                We’ll use this for auto-polish defaults (Messages, Slack, and
                documents). Email greeting and closing stay on Auto where it
                helps. You can refine everything in Settings later.
              </p>

              <h2 className="mb-2 text-left text-[14px] font-medium uppercase tracking-wider text-overlay/48">
                Writing style
              </h2>
              <div
                role="radiogroup"
                aria-label="Default writing style for auto-polish"
                className="grid w-full grid-cols-1 gap-4 min-[600px]:grid-cols-3"
              >
                {WRITING_STYLE_OPTIONS.map(
                  ({ id, label, sublabel, preview }) => {
                    const selected = writingStyleDraft === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setWritingStyleDraft(id)}
                        className={`flex h-full min-h-[220px] w-full flex-col text-left rounded-2xl border transition-all duration-200 cursor-pointer overflow-hidden ${
                          selected
                            ? "border-accent-blue/60 bg-overlay/10 ring-1 ring-accent-blue/40 shadow-lg shadow-blue-500/10"
                            : "border-overlay/11 bg-overlay/4 hover:border-overlay/20 hover:bg-overlay/6"
                        }`}
                      >
                        <div className="p-5 pb-2">
                          <span
                            className={`block text-[26px] tracking-tight ${
                              id === "formal" ? "font-serif" : "font-sans"
                            } ${selected ? "text-white" : "text-overlay/80"}`}
                          >
                            {label}
                          </span>
                          <span
                            className={`mt-1 block text-[13px] font-medium ${
                              selected ? "text-overlay/60" : "text-overlay/40"
                            }`}
                          >
                            {sublabel}
                          </span>
                        </div>

                        <div className="px-4 pb-5 mt-auto pt-6">
                          <div
                            className={`rounded-2xl rounded-br-sm p-4 text-[15px] leading-relaxed whitespace-pre-wrap relative ${
                              selected
                                ? "bg-accent-blue/20 text-blue-50"
                                : "bg-overlay/5 text-overlay/70"
                            }`}
                          >
                            {preview}
                          </div>
                        </div>
                      </button>
                    );
                  },
                )}
              </div>

              <div className="mt-6 w-full rounded-xl border border-overlay/11 bg-overlay/4 px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="block text-[15px] font-medium text-overlay/78">
                      Emoji when polishing
                    </span>
                    <span className="mt-0.5 block text-[16px] text-overlay/40 leading-snug">
                      Allow emoji in polished Messages and Slack output. Off by
                      default.
                    </span>
                  </div>
                  <Switch
                    checked={emojiDraft}
                    onCheckedChange={() => setEmojiDraft((e) => !e)}
                    aria-label="Toggle emoji in formatted chat"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleFinishOnboarding()}
                className="mt-5 w-full py-3 rounded-xl text-[15px] font-medium bg-overlay/12 hover:bg-overlay/18 border border-overlay/14 text-overlay/85 transition-colors disabled:opacity-40"
              >
                Continue to Codictate
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
