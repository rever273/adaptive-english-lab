import { useEffect, useRef } from "react";

/** true while the keys should type text: an editable field. A read-only field (a locked answer) is not one. */
export function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return !t.readOnly;
  if (t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "range", "reset"].includes(t.type) && !t.readOnly;
  return false;
}

/** a focused button or link already reacts to Enter by itself */
export const isPressable = (t: EventTarget | null): boolean => t instanceof HTMLElement && t.closest("button, a, summary, [role=button]") !== null;

/** the small round key label that sits on the corner of a button or option; the button's class must be `has-kbd` */
export function Kbd({ k }: { k: string }) {
  return (
    <span className="kbd" aria-hidden="true">
      {k}
    </span>
  );
}

/** keydown/keyup listeners that always see the latest render's values, attached once */
export function useKeys(onDown: (e: KeyboardEvent) => void, onUp?: (e: KeyboardEvent) => void, onBlur?: () => void): void {
  const down = useRef(onDown);
  const up = useRef(onUp);
  const blur = useRef(onBlur);
  down.current = onDown;
  up.current = onUp;
  blur.current = onBlur;
  useEffect(() => {
    const d = (e: KeyboardEvent) => down.current(e);
    const u = (e: KeyboardEvent) => up.current?.(e);
    const b = () => blur.current?.();
    window.addEventListener("keydown", d);
    window.addEventListener("keyup", u);
    window.addEventListener("blur", b);
    return () => {
      window.removeEventListener("keydown", d);
      window.removeEventListener("keyup", u);
      window.removeEventListener("blur", b);
    };
  }, []);
}
