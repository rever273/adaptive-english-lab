import { Fragment, useEffect, useRef, useState } from "react";
import * as api from "../api";

/** the engine's length_scale is a duration (bigger is slower); the learner sees a speed: 1 is the voice's own pace, 1.2 is 20% faster */
const speedOf = (lengthScale: number): number => Math.round((1 / lengthScale) * 100) / 100;
const lengthScaleOf = (speed: number): number => Math.min(1.8, Math.max(0.7, Math.round((1 / speed) * 100) / 100));

const pct = (n: number | null): string => (n === null ? "—" : `${n}%`);

/** `speed` is kept as typed (a string), so typing and the arrows are never rounded through length_scale and back */
type Draft = { priorWeight: number; speed: string; enabled: boolean };
type Revisions = Awaited<ReturnType<typeof api.fetchVoiceHistory>>["revisions"];

const without = <T,>(map: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

/**
 * Settings → Voices (TASK_029). The starting weight is yours; the speech check and your "Sounds bad" marks multiply it within limits.
 * Every save is a new settings revision, so nothing is lost.
 */
export function VoicesSettings() {
  const [voices, setVoices] = useState<api.VoiceInfo[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [history, setHistory] = useState<Record<string, Revisions>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [heard, setHeard] = useState<Record<string, api.VoiceSampleStats>>({});
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api.fetchVoices().then((r) => setVoices(r.voices)).catch((e) => setMsg(e instanceof Error ? e.message : "Could not load the voices."));
    return () => audio.current?.pause();
  }, []);

  if (!voices) return <section className="card" data-testid="voices-card"><h3>Voices</h3><p className="muted small">{msg ?? "Loading voices…"}</p></section>;

  const draftOf = (v: api.VoiceInfo): Draft => drafts[v.key] ?? { priorWeight: v.weight.prior, speed: String(speedOf(v.lengthScale)), enabled: v.enabled };
  const dirty = (v: api.VoiceInfo): boolean => { const d = draftOf(v); return d.priorWeight !== v.weight.prior || lengthScaleFor(v, d) !== v.lengthScale || d.enabled !== v.enabled; };
  /** the saved length_scale stays as it is until the speed is really changed */
  const lengthScaleFor = (v: api.VoiceInfo, d: Draft): number => (Number(d.speed) > 0 && Number(d.speed) !== speedOf(v.lengthScale) ? lengthScaleOf(Number(d.speed)) : v.lengthScale);
  const patch = (v: api.VoiceInfo, p: Partial<Draft>) => setDrafts({ ...drafts, [v.key]: { ...draftOf(v), ...p } });

  const save = async (v: api.VoiceInfo) => {
    try {
      const r = await api.saveVoiceSettings(v.key, (({ speed: _s, ...rest }) => ({ ...rest, lengthScale: lengthScaleFor(v, draftOf(v)) }))(draftOf(v)));
      setVoices(r.voices);
      setDrafts(without(drafts, v.key));
      setHistory(without(history, v.key));
      setMsg(`${v.name}: saved as a new revision.`);
    } catch (e) { setMsg(e instanceof Error ? e.message : "Could not save."); }
  };

  const sample = async (v: api.VoiceInfo) => {
    try {
      audio.current?.pause();
      setPlaying(v.key);
      const { blob, stats } = await api.fetchVoiceSample(v.key, lengthScaleFor(v, draftOf(v)));
      setHeard((h) => (stats ? { ...h, [v.key]: stats } : without(h, v.key)));
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      await a.play();
    } catch (e) { setPlaying(null); setMsg(e instanceof Error ? e.message : "Could not play the sample."); }
  };

  const toggleHistory = async (v: api.VoiceInfo) => {
    if (history[v.key]) { setHistory(without(history, v.key)); return; }
    try { setHistory({ ...history, [v.key]: (await api.fetchVoiceHistory(v.key)).revisions }); } catch (e) { setMsg(e instanceof Error ? e.message : "Could not load the history."); }
  };

  return (
    <section className="card" data-testid="voices-card" aria-labelledby="voices-h">
      <h3 id="voices-h">Voices</h3>
      <p className="muted small">Weights are a starting point; checks adjust them within limits. Accent and pleasantness are your call. Share is how often a voice is expected to read a sentence in Audio Dictation.</p>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead><tr><th>Voice</th><th>On</th><th title="Your starting weight, 0 to 1.5">Start weight</th><th title="Speed of speech: 1 is the voice model's own pace, 1.2 is 20% faster, 0.8 is 20% slower">Speed</th><th title="How often the speech check heard the sentence back exactly">Heard back</th><th title="Sentences you marked Sounds bad">Marked</th><th title="Starting weight x evaluation x speech check x marks">Weight</th><th>Share</th><th /></tr></thead>
          <tbody>
            {voices.map((v) => {
              const d = draftOf(v);
              return (
                <Fragment key={v.key}>
                  <tr className={v.enabled ? undefined : "muted"}>
                    <td><strong>{v.name}</strong> <span className="muted small">{v.gender}, {v.ageGroup}</span>{v.impression && <div className="muted small">{v.impression}</div>}</td>
                    <td><input type="checkbox" checked={d.enabled} onChange={(e) => patch(v, { enabled: e.target.checked })} aria-label={`${v.name} on`} /></td>
                    <td><input type="range" min={0} max={1.5} step={0.05} value={d.priorWeight} onChange={(e) => patch(v, { priorWeight: Number(e.target.value) })} aria-label={`${v.name} starting weight`} /> {d.priorWeight.toFixed(2)}</td>
                    <td><input type="number" min={0.5} max={1.5} step={0.05} value={d.speed} onChange={(e) => patch(v, { speed: e.target.value })} style={{ width: "5rem" }} aria-label={`${v.name} speed`} />{heard[v.key] && <div className="muted small" title="Measured on the last sample played: audible speech only. Natural conversation is roughly 4-5 syllables a second; under about 3.5 sounds slow.">{heard[v.key]!.syllablesPerSecond} syll/s · {heard[v.key]!.wordsPerMinute} wpm at speed {speedOf(heard[v.key]!.lengthScale)}</div>}</td>
                    <td>{pct(v.heardRate)} <span className="muted small">({v.checks})</span></td>
                    <td>{v.flags}</td>
                    <td title={`start ${v.weight.prior} × evaluation ${v.weight.offline} × speech check ${v.weight.live} × marks ${v.weight.flags}`}>{v.weight.effective}</td>
                    <td>{v.share}%</td>
                    <td className="actions">
                      <button className="btn btn-small" onClick={() => void sample(v)} disabled={playing === v.key}><i className="pi pi-volume-up" aria-hidden="true" /> Play sample</button>
                      <button className="btn btn-small btn-primary" onClick={() => void save(v)} disabled={!dirty(v)}>Save</button>
                      <button className="btn btn-small" onClick={() => void toggleHistory(v)} aria-expanded={Boolean(history[v.key])}>History</button>
                    </td>
                  </tr>
                  {history[v.key] && (
                    <tr><td colSpan={9} className="muted small">{history[v.key]!.map((r) => `#${r.revision} ${r.source}: weight ${r.priorWeight}, speed ${speedOf(r.lengthScale)}${r.enabled ? "" : ", off"}${r.reason ? ` (${r.reason})` : ""}`).join(" · ")}</td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {msg && <p className="notice notice-info small" role="status">{msg}</p>}
    </section>
  );
}
