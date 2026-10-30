import { useState } from "react";
import { AITasks } from "./pages/AITasks";
import { Analytics } from "./pages/Analytics";
import { ContentStudio } from "./pages/ContentStudio";
import { Practice } from "./pages/Practice";
import { Vocabulary } from "./pages/Vocabulary";
import { Tutor } from "./pages/Tutor";
import { Settings } from "./pages/Settings";
import { Status } from "./pages/Status";

type Page = "practice" | "vocabulary" | "tutor" | "analytics" | "studio" | "tasks" | "status" | "settings";

const PAGES: Array<{ id: Page; label: string }> = [
  { id: "practice", label: "Practice" },
  { id: "vocabulary", label: "Vocabulary" },
  { id: "tutor", label: "Tutor" },
  { id: "analytics", label: "Analytics" },
  { id: "studio", label: "Content Studio" },
  { id: "tasks", label: "AI Tasks" },
  { id: "status", label: "Status" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [page, setPage] = useState<Page>("practice");
  return (
    <div className="app">
      <header className="topbar">
        <h1>English Lab</h1>
        <nav aria-label="Main">
          {PAGES.map((p) => (
            <button key={p.id} className={`tab${page === p.id ? " tab-on" : ""}`} aria-current={page === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="shell">{page === "practice" ? <Practice /> : page === "vocabulary" ? <Vocabulary /> : page === "tutor" ? <Tutor /> : page === "analytics" ? <Analytics /> : page === "studio" ? <ContentStudio /> : page === "tasks" ? <AITasks /> : page === "settings" ? <Settings /> : <Status />}</main>
    </div>
  );
}
