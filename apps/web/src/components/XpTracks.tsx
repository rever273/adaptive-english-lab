import { useEffect, useRef, useState } from "react";
import { fetchActivityProgress, type TrackProgress } from "../api";

/** level tiers: a different badge every few levels, so progress feels like a path, not a counter */
const TIERS: Array<{ from: number; name: string; icon: string }> = [
  { from: 1, name: "Bronze", icon: "pi-star" },
  { from: 5, name: "Silver", icon: "pi-star-fill" },
  { from: 10, name: "Gold", icon: "pi-bolt" },
  { from: 20, name: "Platinum", icon: "pi-trophy" },
  { from: 35, name: "Diamond", icon: "pi-crown" },
];
const tierOf = (level: number) => [...TIERS].reverse().find((t) => level >= t.from)!;

const TRACK = {
  grammar: { label: "Grammar", icon: "pi-pencil" },
  vocabulary: { label: "Vocabulary", icon: "pi-bookmark-fill" },
} as const;

function Track({ p, gained, levelUp }: { p: TrackProgress; gained: number; levelUp: boolean }) {
  const t = TRACK[p.track];
  const tier = tierOf(p.level);
  const pct = Math.round((p.withinLevel / p.threshold) * 100);
  const label = `${t.label}: level ${p.level} (${tier.name}), ${p.withinLevel} of ${p.threshold} XP to the next level, ${p.total} XP in total`;
  return (
    <div className={`xp-track xp-${p.track} tier-${tier.name.toLowerCase()}${levelUp ? " xp-levelup" : ""}`} tabIndex={0} aria-label={label} data-testid={`xp-${p.track}`}>
      <span className="xp-badge" aria-hidden="true">
        <i className={`pi ${tier.icon}`} />
        <span className="xp-level">{p.level}</span>
      </span>
      <span className="xp-body" aria-hidden="true">
        <span className="xp-name">
          <i className={`pi ${t.icon}`} /> {t.label} <span className="xp-lv">Lv {p.level}</span>
        </span>
        <span className="xp-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="xp-num">{p.withinLevel} / {p.threshold} XP</span>
      </span>
      {gained > 0 && <span className="xp-gain" key={`${p.total}`} aria-hidden="true">+{gained} XP</span>}
      <span className="xp-tip" role="tooltip">
        <strong>{t.label} · {tier.name} · Level {p.level}</strong>
        <br />
        {p.withinLevel} / {p.threshold} XP to level {p.level + 1} · {p.total} XP total
        <br />
        <span className="muted">10 XP for every finished task (also a wrong one or “I don’t know”); nothing for skips. Activity, not a grade.</span>
      </span>
    </div>
  );
}

/**
 * Two independent progress tracks in the header (vocabulary TZ, stage D): Grammar and Vocabulary level, each from its own server XP ledger.
 * A finished task shows a small “+10 XP” and the bar fills smoothly; a new level makes the badge glow once. No pop-ups, no confetti.
 */
export function XpTracks() {
  const [p, setP] = useState<{ grammar: TrackProgress; vocabulary: TrackProgress } | null>(null);
  const prev = useRef<{ grammar: TrackProgress; vocabulary: TrackProgress } | null>(null);
  const [fx, setFx] = useState<Record<string, { gained: number; levelUp: boolean }>>({});

  useEffect(() => {
    let off = false;
    let clear: number | undefined;
    const load = () =>
      fetchActivityProgress()
        .then((r) => {
          if (off) return;
          const before = prev.current;
          if (before) {
            const next: Record<string, { gained: number; levelUp: boolean }> = {};
            for (const k of ["grammar", "vocabulary"] as const) {
              const gained = r[k].total - before[k].total;
              if (gained > 0) next[k] = { gained, levelUp: r[k].level > before[k].level };
            }
            if (Object.keys(next).length) {
              setFx(next);
              window.clearTimeout(clear);
              clear = window.setTimeout(() => setFx({}), 2200);
            }
          }
          prev.current = r;
          setP(r);
        })
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 15_000);
    window.addEventListener("el:xp", load);
    return () => {
      off = true;
      window.clearInterval(t);
      window.clearTimeout(clear);
      window.removeEventListener("el:xp", load);
    };
  }, []);

  if (!p) return null;
  return (
    <div className="xp-tracks" aria-label="Your levels">
      <Track p={p.grammar} gained={fx.grammar?.gained ?? 0} levelUp={fx.grammar?.levelUp ?? false} />
      <Track p={p.vocabulary} gained={fx.vocabulary?.gained ?? 0} levelUp={fx.vocabulary?.levelUp ?? false} />
    </div>
  );
}
