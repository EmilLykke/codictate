import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import type {
  PermissionState,
  SettingsPane,
  ShortcutId,
  AppSettings,
} from "../../../shared/types";
import { setShortcut } from "../../rpc";
import { appEvents } from "../../app-events";
import { PermissionStep } from "./PermissionStep";
import { ShortcutStep } from "./ShortcutStep";
import { TryItStep } from "./TryItStep";
import { OnboardingStepDots } from "./OnboardingStepDots";
import { WordmarkCodictate } from "../Brand/WordmarkCodictate";

interface PermissionStepConfig {
  key: keyof PermissionState;
  pane: SettingsPane;
  label: string;
  description: string;
  note?: string;
}

const PERMISSION_STEPS: PermissionStepConfig[] = [
  {
    key: "inputMonitoring",
    pane: "inputMonitoring",
    label: "Input Monitoring",
    description:
      "Codictate needs to detect your shortcut key while the app is in the background. Without this, you can only start dictating from the app window.",
    note: "This permission requires an app restart to take effect.",
  },
  {
    key: "microphone",
    pane: "microphone",
    label: "Microphone",
    description:
      "Codictate records your voice locally. Nothing is sent to any server — transcription happens entirely on your Mac using Whisper.",
  },
  {
    key: "accessibility",
    pane: "accessibility",
    label: "Accessibility",
    description:
      "Codictate simulates a paste keystroke to insert text at your cursor. This is the same method used by password managers and clipboard tools.",
  },
  {
    key: "documents",
    pane: "documents",
    label: "Files & Folders",
    description:
      "Codictate saves your recordings temporarily and can store transcription history on your Mac.",
  },
];

const TOTAL_STEPS = PERMISSION_STEPS.length + 2; // permissions + shortcut + try it

const stepVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? 48 : -48,
  }),
  center: {
    opacity: 1,
    x: 0,
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? -48 : 48,
  }),
};

export function OnboardingFlow({
  permissions,
  settings,
  onComplete,
}: {
  permissions: PermissionState;
  settings: AppSettings | undefined;
  onComplete: () => void;
}) {
  const [step, setStep] = useState(0);
  const [selectedShortcut, setSelectedShortcut] = useState<ShortcutId>(
    settings?.shortcutId ?? "option-space",
  );

  // Keep selectedShortcut in sync if settings load after mount
  useEffect(() => {
    if (settings?.shortcutId && step === 0) {
      setSelectedShortcut(settings.shortcutId);
    }
  }, [settings?.shortcutId, step]);

  // Auto-skip permission steps that are already granted
  useEffect(() => {
    if (step < PERMISSION_STEPS.length) {
      const permKey = PERMISSION_STEPS[step].key;
      if (permissions[permKey]) {
        setStep((s) => s + 1);
      }
    }
  }, [step, permissions]);

  const advance = useCallback(() => {
    setStep((s) => s + 1);
  }, []);

  const openSettings = useCallback((pane: SettingsPane) => {
    appEvents.emit("openSettings", pane);
  }, []);

  const handleShortcutChange = useCallback((id: ShortcutId) => {
    setSelectedShortcut(id);
  }, []);

  const handleShortcutContinue = useCallback(async () => {
    await setShortcut(selectedShortcut);
    advance();
  }, [selectedShortcut, advance]);

  const isPermissionStep = step < PERMISSION_STEPS.length;
  const isShortcutStep = step === PERMISSION_STEPS.length;
  const isTryItStep = step === PERMISSION_STEPS.length + 1;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-codictate-page text-white select-none px-6">
      <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 h-7" />

      {/* Header */}
      <div className="absolute top-8 left-0 right-0 flex flex-col items-center gap-3">
        <WordmarkCodictate
          as="span"
          showMark
          className="text-[17px] font-semibold tracking-tight text-white/40"
        />
        <OnboardingStepDots totalSteps={TOTAL_STEPS} currentStep={step} />
      </div>

      {/* Step content */}
      <div className="w-full max-w-[460px]">
        <AnimatePresence mode="wait" custom={1}>
          <motion.div
            key={step}
            custom={1}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {isPermissionStep && (
              <PermissionStep
                label={PERMISSION_STEPS[step].label}
                description={PERMISSION_STEPS[step].description}
                note={PERMISSION_STEPS[step].note}
                granted={permissions[PERMISSION_STEPS[step].key]}
                pane={PERMISSION_STEPS[step].pane}
                onOpenSettings={openSettings}
              />
            )}

            {isShortcutStep && (
              <ShortcutStep
                value={selectedShortcut}
                onChange={handleShortcutChange}
                onContinue={handleShortcutContinue}
              />
            )}

            {isTryItStep && (
              <TryItStep shortcutId={selectedShortcut} onDone={onComplete} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Step counter */}
      <div className="absolute bottom-8 text-[16px] text-white/20">
        {step + 1} / {TOTAL_STEPS}
      </div>
    </div>
  );
}
