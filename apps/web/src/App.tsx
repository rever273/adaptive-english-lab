import { Suspense, lazy, useEffect, useState } from "react";
import { JourneyButton } from "./components/JourneyButton";
import { dailyOrder } from "./pages/dailyOrder";
import * as api from "./api";
import { AiActivity } from "./components/AiActivity";
import { AiModelNotice } from "./components/AiModelNotice";
import { XpTracks } from "./components/XpTracks";
import { WordCatcher } from "./components/WordPopup";
import { DailyGoalNotice } from "./components/DailyGoalNotice";
import { Kbd, useKeys } from "./components/hotkeys";
import { ContentStockNotice } from "./components/ContentStockNotice";

const DailyPractice = lazy(() => import("./pages/DailyPractice").then((m) => ({ default: m.DailyPractice })));
const AITasks = lazy(() => import("./pages/AITasks").then((m) => ({ default: m.AITasks })));
const Analytics = lazy(() => import("./pages/Analytics").then((m) => ({ default: m.Analytics })));
const ContentStudio = lazy(() => import("./pages/ContentStudio").then((m) => ({ default: m.ContentStudio })));
const Practice = lazy(() => import("./pages/Practice").then((m) => ({ default: m.Practice })));
const PracticeHub = lazy(() => import("./pages/PracticeHub").then((m) => ({ default: m.PracticeHub })));
const GrammarCloze = lazy(() => import("./pages/GrammarCloze").then((m) => ({ default: m.GrammarCloze })));
const Vocabulary = lazy(() => import("./pages/Vocabulary").then((m) => ({ default: m.Vocabulary })));
const Typing = lazy(() => import("./pages/Typing").then((m) => ({ default: m.Typing })));
const Conversation = lazy(() => import("./pages/Conversation").then((m) => ({ default: m.Conversation })));
const Tutor = lazy(() => import("./pages/Tutor").then((m) => ({ default: m.Tutor })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Status = lazy(() => import("./pages/Status").then((m) => ({ default: m.Status })));

type Page = "daily" | "practice" | "vocabulary" | "typing" | "conversation" | "tutor" | "analytics" | "studio" | "tasks" | "settings";

const PAGES: Array<{ id: Page; label: string; icon: string; path: string; group: "daily" | "tasks" | "tools" }> = [
  { id: "daily", label: "Daily Practice", icon: "pi-calendar", path: "/daily", group: "daily" },
  { id: "practice", label: "Practice", icon: "pi-play-circle", path: "/practice", group: "tasks" },
  { id: "vocabulary", label: "Vocabulary", icon: "pi-bookmark", path: "/vocabulary", group: "tasks" },
  { id: "typing", label: "Typing", icon: "pi-bullseye", path: "/typing", group: "tasks" },
  { id: "conversation", label: "Conversation", icon: "pi-comments", path: "/conversation", group: "tasks" },
  { id: "tutor", label: "Tutor", icon: "pi-comments", path: "/tutor", group: "tools" },
  { id: "analytics", label: "Analytics", icon: "pi-chart-line", path: "/analytics", group: "tools" },
  { id: "studio", label: "Content Studio", icon: "pi-box", path: "/content-studio", group: "tools" },
  { id: "tasks", label: "AI Tasks", icon: "pi-microchip", path: "/ai-tasks", group: "tools" },
  { id: "settings", label: "Settings & Status", icon: "pi-cog", path: "/settings", group: "tools" },
];

/** each tab has its own address (e.g. /vocabulary), so a reload or a bookmark opens the same tab; an unknown address shows Practice */
const pageAtPath = (pathname: string): Page => (pathname.startsWith("/practice") ? "practice" : PAGES.find((p) => p.path === pathname.replace(/\/+$/, ""))?.id ?? "practice");

/** /practice is the choice of the two grammar practices; /practice/grammar is the classic Practice, /practice/cloze is Grammar Cloze (TASK_032) */
type PracticeView = "hub" | "grammar" | "cloze";
const practiceViewAt = (pathname: string): PracticeView => (pathname.startsWith("/practice/cloze") ? "cloze" : pathname.startsWith("/practice/grammar") ? "grammar" : "hub");
const PRACTICE_PATH: Record<PracticeView, string> = { hub: "/practice", grammar: "/practice/grammar", cloze: "/practice/cloze" };

/**
 * One small event stream to the server keeps this tab linked to it. When the server stops the browser keeps retrying by itself; the moment a
 * server answers again the page reloads, so a restart updates THIS tab (and `npm start` does not open another one).
 */
function useServerLink(): { down: boolean; replaced: boolean } {
  const [down, setDown] = useState(false);
  const [replaced, setReplaced] = useState(false);
  useEffect(() => {
    let wasDown = false;
    const id = crypto.randomUUID();
    const es = new EventSource(`/api/v1/ui/stream?id=${id}`);
    // another English Lab tab was opened (or came back): this one steps aside and stops reconnecting, so there is only ever one live tab
    es.addEventListener("replaced", () => {
      es.close();
      setReplaced(true);
      try { window.close(); } catch { /* only a tab opened by a script can close itself */ }
    });
    es.onerror = () => {
      wasDown = true;
      setDown(true);
    };
    // After sleep the stream reconnects before the network stack has settled; a reload then can get an empty answer and leave a blank page
    // with no script to recover it. So reload only once the page itself is served in full, and keep trying until it is.
    let reloadTimer: number | undefined;
    const reloadWhenServed = async () => {
      try {
        const r = await fetch("/", { cache: "no-store" });
        if (r.ok && (await r.text()).includes('id="root"')) { window.location.reload(); return; }
      } catch { /* not yet */ }
      reloadTimer = window.setTimeout(() => void reloadWhenServed(), 2000);
    };
    es.onopen = () => {
      if (wasDown && reloadTimer === undefined) reloadTimer = window.setTimeout(() => void reloadWhenServed(), 1000);
    };
    return () => { es.close(); window.clearTimeout(reloadTimer); };
  }, []);
  return { down, replaced };
}

export function App() {
  const { down: serverDown, replaced: tabReplaced } = useServerLink();
  const [page, setPage] = useState<Page>(() => pageAtPath(window.location.pathname));
  // a link from one page to a sub-view of another (Vocabulary -> Content Studio's vocabulary category, a vocabulary summary -> its analytics)
  const [focus, setFocus] = useState<"grammar" | "vocabulary" | "journey">("grammar");
  const [practiceView, setPracticeView] = useState<PracticeView>(() => practiceViewAt(window.location.pathname));
  const go = (p: Page, sub: "grammar" | "vocabulary" | "journey" = "grammar", pv: PracticeView = "hub") => {
    setFocus(sub);
    setPage(p);
    setPracticeView(pv);
    const path = p === "practice" ? PRACTICE_PATH[pv] : PAGES.find((x) => x.id === p)!.path;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  };
  const [dailyMode, setDailyMode] = useState<api.JourneyMode | null>(() => { try { return sessionStorage.getItem("el_daily_mode") as api.JourneyMode | null; } catch { return null; } });
  const [sequential, setSequential] = useState(() => { try { return localStorage.getItem("el_daily_sequence") === "1"; } catch { return false; } });
  const launchDaily = (mode: api.JourneyMode) => {
    setDailyMode(mode); try { sessionStorage.setItem("el_daily_mode", mode); } catch { /* storage unavailable */ }
    if (mode === "grammar" || mode === "grammarCloze") { go("practice", "grammar", mode === "grammar" ? "grammar" : "cloze"); return; }
    go(mode === "conversation" ? "conversation" : mode === "vocabulary" || mode === "wordLesson" || mode === "contextLoop" ? "vocabulary" : "typing");
  };
  const leaveDaily = () => { setDailyMode(null); try { sessionStorage.removeItem("el_daily_mode"); } catch { /* storage unavailable */ } go("daily"); };
  const dailyDone = async () => {
    if (sequential && dailyMode) {
      try { const d = await api.fetchJourney(); const next = dailyOrder(d.dailyMinutes,d.todayMs,d.dailyOrder).find(m => m !== dailyMode && d.dailyMinutes[m] > 0 && d.todayMs[m] < d.dailyMinutes[m] * 60000); if (next) { launchDaily(next); return; } } catch { /* return to the plan */ }
    }
    leaveDaily();
  };
  // the browser's Back and Forward buttons move between tabs
  useEffect(() => {
    const onPop = () => {
      setFocus("grammar");
      setPage(pageAtPath(window.location.pathname));
      setPracticeView(practiceViewAt(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Alt+1 ... Alt+9 and Alt+0 open the tabs
  useKeys((e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const i = e.key === "0" ? 9 : Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < PAGES.length) {
      e.preventDefault();
      go(PAGES[i]!.id);
    }
  });
  return (
    <div className="app">
      {tabReplaced && (
        <div className="tab-replaced" role="alert" data-testid="tab-replaced">
          <p><i className="pi pi-clone" aria-hidden="true" /> English Lab is open in another tab. You can close this one.</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Use this tab instead</button>
        </div>
      )}
      {serverDown && (
        <div className="server-down" role="alert" data-testid="server-down">
          <i className="pi pi-spin pi-spinner" aria-hidden="true" /> The server is not running. This page reconnects and reloads by itself as soon as it starts again.
        </div>
      )}
      <header className="topbar">
        <div className="topbar-row">
          <h1>
            <i className="pi pi-graduation-cap" aria-hidden="true" /> English Lab
          </h1>
          <XpTracks />
          <JourneyButton onOpen={() => go("analytics", "journey")} />
        </div>
        <nav aria-label="Main">
          {(["daily", "tasks", "tools"] as const).map((g) => (
            <div key={g} className="tab-group">
              {PAGES.map((p, i) => p.group === g && (
            <button key={p.id} className={`tab has-kbd${page === p.id ? " tab-on" : ""}`} aria-current={page === p.id ? "page" : undefined} onClick={() => { setDailyMode(null); try { sessionStorage.removeItem("el_daily_mode"); } catch { /* unavailable */ } go(p.id); }} title={`Alt+${i === 9 ? 0 : i + 1}`}>
              <Kbd k={String(i === 9 ? 0 : i + 1)} />
              <i className={`pi ${p.icon}`} aria-hidden="true" />
              {p.label}
            </button>
              ))}
            </div>
          ))}
        </nav>
      </header>
      <main className="shell">
        <Suspense fallback={null}>
        {page === "daily" ? (
          <DailyPractice onStart={launchDaily} sequential={sequential} onSequential={v => { setSequential(v); try { localStorage.setItem("el_daily_sequence", v ? "1" : "0"); } catch { /* unavailable */ } }} />
        ) : page === "practice" ? (
          practiceView === "hub" ? (
            <PracticeHub onOpen={(v) => go("practice", "grammar", v)} />
          ) : (
            <>
              <p className="gc-back"><button type="button" className="btn" onClick={() => go("practice")} data-testid="practice-back"><i className="pi pi-arrow-left" aria-hidden="true" /> All practice</button></p>
              {practiceView === "grammar" ? (
                <Practice dailyStart={dailyMode === "grammar"} onDailyDone={dailyMode === "grammar" ? () => void dailyDone() : undefined} onNavigate={(p) => go(p)} />
              ) : (
                <GrammarCloze dailyStart={dailyMode === "grammarCloze"} onDailyDone={dailyMode === "grammarCloze" ? () => void dailyDone() : undefined} />
              )}
            </>
          )
        ) : page === "vocabulary" ? (
          <Vocabulary dailyStart={dailyMode === "vocabulary"} wordLessonFocus={dailyMode === "wordLesson"} contextLoopStart={dailyMode === "contextLoop"} onDailyDone={dailyMode === "vocabulary" || dailyMode === "wordLesson" || dailyMode === "contextLoop" ? () => void dailyDone() : undefined} onNavigate={(p) => go(p, "vocabulary")} />
        ) : page === "typing" ? (
          <Typing key={dailyMode ?? "typing"} dailyStart={dailyMode === "words" || dailyMode === "books" || dailyMode === "dictation" || dailyMode === "vocabTyping" ? dailyMode : undefined} onDailyDone={dailyMode === "words" || dailyMode === "books" || dailyMode === "dictation" || dailyMode === "vocabTyping" ? () => void dailyDone() : undefined} onNavigate={(p) => go(p)} />
        ) : page === "conversation" ? (
          <Conversation onDailyDone={dailyMode === "conversation" ? () => void dailyDone() : undefined} />
        ) : page === "tutor" ? (
          <Tutor />
        ) : page === "analytics" ? (
          <Analytics key={`a-${focus}`} initialView={focus} />
        ) : page === "studio" ? (
          <ContentStudio key={`s-${focus}`} initialView={focus === "journey" ? "grammar" : focus} />
        ) : page === "tasks" ? (
          <AITasks />
        ) : (
          <>
            <Settings />
            <Status />
          </>
        )}
        </Suspense>
      </main>
      <WordCatcher />
      <DailyGoalNotice />
      {page !== "studio" && <ContentStockNotice onOpen={c => go("studio", c)} />}
      <AiActivity onOpenTasks={() => go("tasks")} />
      <AiModelNotice />
    </div>
  );
}
