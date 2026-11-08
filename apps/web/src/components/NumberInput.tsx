import { useEffect, useRef, useState, type ComponentProps } from "react";

type Props = Omit<ComponentProps<"input">, "type" | "value" | "onChange" | "min" | "max"> & {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

/** Keep incomplete edits local; only valid whole numbers reach the parent and its autosave. */
export function NumberInput({ value, min, max, onChange, onBlur, onFocus, ...props }: Props) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  return <input {...props} type="number" min={min} max={max} step={1} value={text}
    onFocus={(event) => { focused.current = true; onFocus?.(event); }}
    onChange={(event) => {
      const raw = event.currentTarget.value;
      setText(raw);
      const n = Number(raw);
      if (raw.trim() !== "" && Number.isInteger(n) && n >= min && n <= max) onChange(n);
    }}
    onBlur={(event) => {
      focused.current = false;
      const raw = event.currentTarget.value;
      const n = Number(raw);
      const next = raw.trim() !== "" && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : value;
      setText(String(next));
      if (next !== value) onChange(next);
      onBlur?.(event);
    }} />;
}
