import { motion } from "motion/react";

export function OnboardingStepDots({
  totalSteps,
  currentStep,
}: {
  totalSteps: number;
  currentStep: number;
}) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: totalSteps }, (_, i) => (
        <motion.div
          key={i}
          animate={{
            scale: i === currentStep ? 1.25 : 1,
            opacity: i === currentStep ? 1 : i < currentStep ? 0.4 : 0.2,
          }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className="w-1.5 h-1.5 rounded-full bg-white"
        />
      ))}
    </div>
  );
}
