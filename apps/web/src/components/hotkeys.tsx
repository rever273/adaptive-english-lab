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

/**
 * The final statistics window of a lesson: Enter does what its main "continue" button does. It is ignored while a button, link or
 * text field has the focus (that element reacts to Enter itself), on a held key, and for a moment after the window opens, so the
 * Enter that closed the last exercise cannot skip the statistics unseen. `action` null = the window is not on screen.
 */
export const RESULT_ENTER_GRACE_MS = 500;
export function useEnterContinue(action: (() => void) | null): void {
  const shownAt = useRef(0);
  const was = useRef(false);
  if (action && !was.current) shownAt.current = Date.now();
  was.current = action !== null;
  useKeys((e) => {
    if (!action || e.key !== "Enter" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (isTextField(e.target) || isPressable(e.target) || Date.now() - shownAt.current < RESULT_ENTER_GRACE_MS) return;
    e.preventDefault();
    action();
  });
}

/**
 * The function keys mean the same thing on every practice screen (Words, Books, Dictation, Grammar cloze, Word lesson, Memory check).
 * A screen uses only the ones it has; nothing else may bind these keys. Change a key here and every screen, label and hint follows.
 *   F2 pause / resume · F3 Russian translation · F4 listen again · F5 hint · F6 show the answer
 */
export const HOTKEYS = { pause: "F2", translate: "F3", listen: "F4", hint: "F5", showAnswer: "F6" } as const;
export type HotkeyAction = keyof typeof HOTKEYS;

/** the action of a plain function-key press (no modifiers, not held down), else null */
export function hotkeyAction(e: KeyboardEvent): HotkeyAction | null {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return null;
  for (const a of Object.keys(HOTKEYS) as HotkeyAction[]) if (HOTKEYS[a] === e.key) return a;
  return null;
}
