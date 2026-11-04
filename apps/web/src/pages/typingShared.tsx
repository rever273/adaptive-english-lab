import { useCallback, useEffect, useRef, useState } from "react";

/** A short, unobtrusive message: `show()` displays it for `ms`, then it disappears by itself. */
export function useToast(ms = 3000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback(() => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [on, show];
}

export function Toast({ text }: { text: string }) {
  return <div className="typing-toast" role="status">{text}</div>;
}

/** a key typed on the Russian layout is not an error, only a reminder to switch */
export const CYRILLIC = /[Ѐ-ӿ]/;
export const LAYOUT_HINT = "Switch your keyboard to English";
