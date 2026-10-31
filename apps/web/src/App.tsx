import { useEffect, useState } from "react";
import { AITasks } from "./pages/AITasks";
import { Analytics } from "./pages/Analytics";
import { ContentStudio } from "./pages/ContentStudio";
import { Practice } from "./pages/Practice";
import { Vocabulary } from "./pages/Vocabulary";
import { Tutor } from "./pages/Tutor";
import { Settings } from "./pages/Settings";
import { Status } from "./pages/Status";
import { AiActivity } from "./components/AiActivity";
import { XpTracks } from "./components/XpTracks";
import { WordCatcher } from "./components/WordPopup";
import { Kbd, useKeys } from "./components/hotkeys";
import { ContentStockNotice } from "./components/ContentStockNotice";

type Page = "practice" | "vocabulary" | "tutor" | "analytics" | "studio" | "tasks" | "settings";

const PAGES: Array<{ id: Page; label: string; icon: string }> = [
  { id: "practice", label: "Practice", icon: "pi-play-circle" },
  { id: "vocabulary", label: "Vocabulary", icon: "pi-bookmark" },
  { id: "tutor", label: "Tutor", icon: "pi-comments" },
  { id: "analytics", label: "Analytics", icon: "pi-chart-line" },
  { id: "studio", label: "Content Studio", icon: "pi-box" },
  { id: "tasks", label: "AI Tasks", icon: "pi-microchip" },
  { id: "settings", label: "Settings & Status", icon: "pi-cog" },
];

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
  const [page, setPage] = useState<Page>("practice");
  // a link from one page to a sub-view of another (Vocabulary -> Content Studio's vocabulary category, a vocabulary summary -> its analytics)
  const [focus, setFocus] = useState<"grammar" | "vocabulary">("grammar");
  const go = (p: Page, sub: "grammar" | "vocabulary" = "grammar") => {
    setFocus(sub);
    setPage(p);
  };
  // Alt+1 ... Alt+7 open the tabs
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
            <button key={p.id} className={`tab has-kbd${page === p.id ? " tab-on" : ""}`} aria-current={page === p.id ? "page" : undefined} onClick={() => go(p.id)} title={`Alt+${i + 1}`}>
              <Kbd k={String(i + 1)} />
              <i className={`pi ${p.icon}`} aria-hidden="true" />
              {p.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="shell">
        {page === "practice" ? (
          <Practice onNavigate={(p) => go(p)} />
        ) : page === "vocabulary" ? (
          <Vocabulary onNavigate={(p) => go(p, "vocabulary")} />
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
      </main>
      <WordCatcher />
      {page !== "studio" && <ContentStockNotice onOpen={c => go("studio", c)} />}
      <AiActivity onOpenTasks={() => go("tasks")} />
    </div>
  );
}
