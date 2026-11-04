/**
 * Compact QWERTY hint for touch typing: the key to press next lights up and so does the finger that should press it.
 * It only reads the next character; it never takes input and has no effect on the games.
 * The finger zones and their colours follow the standard touch-typing scheme used by vkeyboardhand (MIT,
 * https://github.com/ayuday/vkeyboardhand); the keyboard and hands are drawn here as plain SVG so nothing else is shipped.
 */

type Finger = "lp" | "lr" | "lm" | "li" | "ri" | "rm" | "rr" | "rp" | "th";

const COLORS: Record<Finger, string> = {
  lp: "#ff9f43",
  lr: "#f368e0",
  lm: "#17c0eb",
  li: "#1dd1a1",
  ri: "#0abde3",
  rm: "#a29bfe",
  rr: "#fd79a8",
  rp: "#fdcb6e",
  th: "#9b8cff",
};

interface KeyDef {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  finger: Finger;
}

const ROWS: Array<{ keys: string; fingers: Finger[]; x: number }> = [
  { keys: "qwertyuiop-", fingers: ["lp", "lr", "lm", "li", "li", "ri", "ri", "rm", "rr", "rp", "rp"], x: 0.6 },
  { keys: "asdfghjkl;'", fingers: ["lp", "lr", "lm", "li", "li", "ri", "ri", "rm", "rr", "rp", "rp"], x: 0.9 },
  { keys: "zxcvbnm,./", fingers: ["lp", "lr", "lm", "li", "li", "ri", "ri", "rm", "rr", "rp"], x: 1.8 },
];

const KEY = 28;
const PITCH = 31;
const KEYS: KeyDef[] = [
  ...ROWS.flatMap((r, row) => r.keys.split("").map((ch, i): KeyDef => ({ id: ch, label: ch, x: (r.x + i) * PITCH, y: row * PITCH, w: KEY, finger: r.fingers[i]! }))),
  { id: "shift-l", label: "⇧", x: 0, y: 2 * PITCH, w: 1.7 * PITCH - 3, finger: "lp" },
  { id: "shift-r", label: "⇧", x: 11.8 * PITCH, y: 2 * PITCH, w: 1.5 * PITCH - 3, finger: "rp" },
  { id: " ", label: "", x: 3.2 * PITCH, y: 3 * PITCH, w: 6.4 * PITCH - 3, finger: "th" },
];
const KEYBOARD_W = 13.3 * PITCH;
const KEYBOARD_H = 4 * PITCH - 3;

const SHIFTED: Record<string, string> = { "?": "/", ":": ";", '"': "'", "_": "-", "<": ",", ">": "." };

/** which key (and shift, if any) types this character; null for characters this compact keyboard does not show */
export function keyFor(ch: string | null): { key: string; shift: boolean } | null {
  if (!ch) return null;
  if (ch === " ") return { key: " ", shift: false };
  const lower = ch.toLowerCase();
  if (/^[a-z]$/.test(lower)) return { key: lower, shift: ch !== lower };
  if (SHIFTED[ch]) return { key: SHIFTED[ch]!, shift: true };
  if (KEYS.some((k) => k.id === ch)) return { key: ch, shift: false };
  return null;
}

export function fingersFor(ch: string | null): Finger[] {
  const hit = keyFor(ch);
  if (!hit) return [];
  const key = KEYS.find((k) => k.id === hit.key);
  if (!key) return [];
  const fingers: Finger[] = [key.finger];
  if (hit.shift) fingers.push(key.finger.startsWith("l") ? "rp" : "lp");
  return fingers;
}

const HAND_W = 100;
const HAND_H = KEYBOARD_H;

/** one hand seen from above, fingers up; `left` mirrors the layout so the thumb is on the inner side */
function Hand({ side, active }: { side: "l" | "r"; active: Finger[] }) {
  // finger boxes: x, top y, height (little, ring, middle, index) from the outer edge, then the thumb
  const spec: Array<{ f: Finger; x: number; y: number; h: number }> = [
    { f: `${side}p` as Finger, x: 4, y: 48, h: 42 },
    { f: `${side}r` as Finger, x: 25, y: 28, h: 62 },
    { f: `${side}m` as Finger, x: 46, y: 18, h: 72 },
    { f: `${side}i` as Finger, x: 67, y: 30, h: 60 },
  ];
  const palm = (
    <rect x={2} y={78} width={90} height={42} rx={18} className="tk-skin" />
  );
  const finger = (f: Finger, x: number, y: number, h: number, w = 19) => {
    const on = active.includes(f);
    return <rect key={f} x={x} y={y} width={w} height={h} rx={9.5} className={on ? "tk-finger on" : "tk-skin"} style={on ? { fill: COLORS[f], filter: `drop-shadow(0 0 5px ${COLORS[f]})` } : undefined} />;
  };
  // drawn as a left hand (little finger outermost on the left); the right hand is its mirror image
  const mirror = side === "l" ? undefined : `translate(${HAND_W} 0) scale(-1 1)`;
  const thumbOn = active.includes("th");
  return (
    <g transform={mirror}>
      {palm}
      {spec.map((s) => finger(s.f, s.x, s.y, s.h))}
      <rect x={72} y={74} width={24} height={34} rx={12} transform="rotate(32 84 90)" className={thumbOn ? "tk-finger on" : "tk-skin"} style={thumbOn ? { fill: COLORS.th, filter: `drop-shadow(0 0 5px ${COLORS.th})` } : undefined} />
    </g>
  );
}

export function TypingKeyboard({ next }: { next: string | null }) {
  const hit = keyFor(next);
  const lit = new Set<string>();
  if (hit) {
    lit.add(hit.key);
    if (hit.shift) lit.add(KEYS.find((k) => k.id === hit.key)!.finger.startsWith("l") ? "shift-r" : "shift-l");
  }
  const fingers = fingersFor(next);
  const gap = 10;
  const totalW = HAND_W + gap + KEYBOARD_W + gap + HAND_W;
  return (
    <div className="typing-keyboard" aria-hidden="true" data-testid="typing-keyboard" data-next={next ?? ""}>
      <svg viewBox={`0 0 ${totalW} ${HAND_H}`} className="tk-svg">
        <Hand side="l" active={fingers.filter((f) => f.startsWith("l"))} />
        <g transform={`translate(${HAND_W + gap} 0)`}>
          {KEYS.map((k) => {
            const on = lit.has(k.id);
            const color = COLORS[k.finger];
            return (
              <g key={k.id}>
                <rect x={k.x} y={k.y} width={k.w} height={KEY} rx={5} className={on ? "tk-key on" : "tk-key"} style={on ? { fill: color, filter: `drop-shadow(0 0 6px ${color})` } : { fill: `${color}26`, stroke: `${color}66` }} />
                {k.label && <text x={k.x + k.w / 2} y={k.y + KEY / 2 + 4} textAnchor="middle" className={on ? "tk-text on" : "tk-text"}>{k.label}</text>}
              </g>
            );
          })}
          {/* home-row bumps on F and J */}
          {["f", "j"].map((id) => {
            const k = KEYS.find((x) => x.id === id)!;
            return <rect key={id} x={k.x + KEY / 2 - 4} y={k.y + KEY - 6} width={8} height={2} rx={1} className="tk-bump" />;
          })}
        </g>
        <g transform={`translate(${HAND_W + gap + KEYBOARD_W + gap} 0)`}>
          <Hand side="r" active={fingers.filter((f) => f.startsWith("r") || f === "th")} />
        </g>
      </svg>
    </div>
  );
}
