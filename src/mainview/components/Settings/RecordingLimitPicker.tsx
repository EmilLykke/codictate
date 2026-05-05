import { useMemo } from "react";
import {
  RECORDING_DURATION_PRESET_SECONDS,
  formatRecordingDurationLabel,
} from "../../../shared/recording-duration-presets";
import { DropdownSelect } from "../Common/DropdownSelect";

export function RecordingLimitPicker({
  valueSeconds,
  onChange,
}: {
  valueSeconds: number;
  onChange: (seconds: number) => void;
}) {
  const options = useMemo(
    () =>
      RECORDING_DURATION_PRESET_SECONDS.map((s) => ({
        value: String(s),
        label: formatRecordingDurationLabel(s),
      })),
    [],
  );

  return (
    <DropdownSelect
      value={String(valueSeconds)}
      options={options}
      onChange={(v) => onChange(Number(v))}
      ariaLabel="Recording duration limit"
    />
  );
}
