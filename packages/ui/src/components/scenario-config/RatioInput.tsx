import type { KeyboardEvent } from "react";
import { Input } from "../ui/input";
import { FieldLabel } from "./FieldLabel";
import type { RatioFieldType } from "./ratio-defaults";

interface RatioInputProps {
  label: string;
  field: string;
  defaultValue: number;
  type: RatioFieldType;
  value: string;
  onChange: (key: string, value: string) => void;
  hint?: string;
}

function getInputProps(type: RatioFieldType) {
  switch (type) {
    case "rate":
      return { step: "0.01", min: "0", max: "1" };
    case "integer":
      return { step: "1", min: "0" };
    case "currency":
      return { step: "100", min: "0" };
  }
}

export function RatioInput({
  label,
  field,
  defaultValue,
  type,
  value,
  onChange,
  hint
}: RatioInputProps) {
  const inputProps = getInputProps(type);
  const step = parseFloat(inputProps.step);
  const min = parseFloat(inputProps.min);
  const max = inputProps.max !== undefined ? parseFloat(inputProps.max) : Infinity;

  function clamp(v: number) {
    return Math.min(max, Math.max(min, v));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (value !== "" || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? step : -step;
    onChange(field, String(clamp(defaultValue + delta)));
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const nativeEvent = e.nativeEvent as InputEvent;
    if (value === "" && nativeEvent.inputType !== "insertText") {
      const raw = parseFloat(e.target.value);
      if (!isNaN(raw)) {
        const rebased = clamp(defaultValue + (raw > 0 ? step : -step));
        onChange(field, String(rebased));
        return;
      }
    }
    onChange(field, e.target.value);
  }

  function handleBlur() {
    if (value === "") return;
    const num = parseFloat(value);
    if (isNaN(num)) {
      onChange(field, "");
      return;
    }
    let clamped = clamp(num);
    if (type === "integer") clamped = Math.round(clamped);
    if (String(clamped) !== value) onChange(field, String(clamped));
  }

  return (
    <div className="grid gap-1.5">
      <FieldLabel htmlFor={`ratio-${field}`} hint={hint} className="text-xs">
        {label}
      </FieldLabel>
      <Input
        id={`ratio-${field}`}
        type="number"
        placeholder={String(defaultValue)}
        value={value}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        onBlur={handleBlur}
        {...inputProps}
        className="h-8 text-sm"
      />
      <span className="text-[11px] text-muted-foreground">(default: {defaultValue})</span>
    </div>
  );
}
