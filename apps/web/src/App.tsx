import { Suspense, lazy, useEffect, useState } from "react";
import { AiActivity } from "./components/AiActivity";
import { AiModelNotice } from "./components/AiModelNotice";
import { XpTracks } from "./components/XpTracks";
import { WordCatcher } from "./components/WordPopup";
import { Kbd, useKeys } from "./components/hotkeys";
import { ContentStockNotice } from "./components/ContentStockNotice";

const AITasks = lazy(() => import("./pages/AITasks").then((m) => ({ default: m.AITasks })));
const Analytics = lazy(() => import("./pages/Analytics").then((m) => ({ default: m.Analytics })));
const ContentStudio = lazy(() => import("./pages/ContentStudio").then((m) => ({ default: m.ContentStudio })));
const Practice = lazy(() => import("./pages/Practice").then((m) => ({ default: m.Practice })));
const Vocabulary = lazy(() => import("./pages/Vocabulary").then((m) => ({ default: m.Vocabulary })));
const Typing = lazy(() => import("./pages/Typing").then((m) => ({ default: m.Typing })));
const Tutor = lazy(() => import("./pages/Tutor").then((m) => ({ default: m.Tutor })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Status = lazy(() => import("./pages/Status").then((m) => ({ default: m.Status })));

type Page = "practice" | "vocabulary" | "typing" | "tutor" | "analytics" | "studio" | "tasks" | "settings";

const PAGES: Array<{ id: Page; label: string; icon: string; path: string; group: "tasks" | "tools" }> = [
  { id: "practice", label: "Practice", icon: "pi-play-circle", path: "/practice", group: "tasks" },
  { id: "vocabulary", label: "Vocabulary", icon: "pi-bookmark", path: "/vocabulary", group: "tasks" },
  { id: "typing", label: "Typing", icon: "pi-bullseye", path: "/typing", group: "tasks" },
  { id: "tutor", label: "Tutor", icon: "pi-comments", path: "/tutor", group: "tools" },
  { id: "analytics", label: "Analytics", icon: "pi-chart-line", path: "/analytics", group: "tools" },
  { id: "studio", label: "Content Studio", icon: "pi-box", path: "/content-studio", group: "tools" },
  { id: "tasks", label: "AI Tasks", icon: "pi-microchip", path: "/ai-tasks", group: "tools" },
  { id: "settings", label: "Settings & Status", icon: "pi-cog", path: "/settings", group: "tools" },
];

/** each tab has its own address (e.g. /vocabulary), so a reload or a bookmark opens the same tab; an unknown address shows Practice */
const pageAtPath = (pathname: string): Page => PAGES.find((p) => p.path === pathname.replace(/\/+$/, ""))?.id ?? "practice";

/**
 * One small event stream to the server keeps this tab linked to it. When the server stops the browser keeps retrying by itself; the moment a
 * server answers again the page reloads, so a restart updates THIS tab (and `npm start` does not open another one).
 */
function useServerLink(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    let wasDown = false;
    const es = new EventSource("/api/v1/ui/stream");
    es.onerror = () => {
      wasDown = true;
      setDown(true);
    };
    es.onopen = () => {
      if (wasDown) window.location.reload();
    };
    return () => es.close();
  }, []);
  return down;
}

export function App() {
  const serverDown = useServerLink();
  const [page, setPage] = useState<Page>(() => pageAtPath(window.location.pathname));
  // a link from one page to a sub-view of another (Vocabulary -> Content Studio's vocabulary category, a vocabulary summary -> its analytics)
  const [focus, setFocus] = useState<"grammar" | "vocabulary">("grammar");
  const go = (p: Page, sub: "grammar" | "vocabulary" = "grammar") => {
    setFocus(sub);
    setPage(p);
    const path = PAGES.find((x) => x.id === p)!.path;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  };
  // the browser's Back and Forward buttons move between tabs
  useEffect(() => {
    const onPop = () => {
      setFocus("grammar");
      setPage(pageAtPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Alt+1 ... Alt+8 open the tabs
  useKeys((e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < PAGES.length) {
      e.preventDefault();
      go(PAGES[i]!.id);
    }
  });
  return (
    <div className="app">
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
        </div>
        <nav aria-label="Main">
          {PAGES.map((p, i) => (
            <button key={p.id} className={`tab has-kbd${page === p.id ? " tab-on" : ""}${i > 0 && p.group === "tools" && PAGES[i - 1]!.group === "tasks" ? " tab-group-start" : ""}`} aria-current={page === p.id ? "page" : undefined} onClick={() => go(p.id)} title={`Alt+${i + 1}`}>
              <Kbd k={String(i + 1)} />
              <i className={`pi ${p.icon}`} aria-hidden="true" />
              {p.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="shell">
        <Suspense fallback={null}>
        {page === "practice" ? (
          <Practice onNavigate={(p) => go(p)} />
        ) : page === "vocabulary" ? (
          <Vocabulary onNavigate={(p) => go(p, "vocabulary")} />
        ) : page === "typing" ? (
          <Typing onNavigate={(p) => go(p)} />
        ) : page === "tutor" ? (
          <Tutor />
        ) : page === "analytics" ? (
          <Analytics key={`a-${focus}`} initialView={focus} />
        ) : page === "studio" ? (
          <ContentStudio key={`s-${focus}`} initialView={focus} />
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
      {page !== "studio" && <ContentStockNotice onOpen={c => go("studio", c)} />}
      <AiActivity onOpenTasks={() => go("tasks")} />
      <AiModelNotice />
    </div>
  );
}
