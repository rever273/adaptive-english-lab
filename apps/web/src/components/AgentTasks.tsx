import { useState } from "react";
import { fetchAgentTask } from "../api";

/** D62: two complete prompts for the learner's coding agent. The text holds IDs and commands only, never answers. */
export function AgentTasks() {
  const [task, setTask] = useState<{ text: string; copied: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = async (kind: "progress" | "lessons") => {
    setError(null);
    try {
      const { text } = await fetchAgentTask(kind);
      let copied = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        copied = false;
      }
      setTask({ text, copied });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card" data-testid="agent-tasks">
      <h3><i className="pi pi-sparkles" aria-hidden="true" /> Work with your coding agent</h3>
      <p className="small muted">Copies a complete task for your agent (for example in VS Code). New lesson structures use computed priorities; exercises are created and independently reviewed separately in Content Studio.</p>
      <div className="actions">
        <button className="btn" onClick={() => void copy("progress")} data-testid="copy-progress">
          <i className="pi pi-check-square" aria-hidden="true" /> Copy task: review my results
        </button>
        <button className="btn" onClick={() => void copy("lessons")} data-testid="copy-lessons">
          <i className="pi pi-plus-circle" aria-hidden="true" /> Copy task: create new lessons
        </button>
      </div>
      {error && (
        <p className="notice notice-error small" role="alert">
          {error}
        </p>
      )}
      {task && (
        <div>
          <p className="small" role="status">
            {task.copied ? "Copied. Paste it into your agent's chat." : "Could not use the clipboard. Select and copy the text below."}
          </p>
          <textarea readOnly rows={6} value={task.text} aria-label="Agent task text" style={{ width: "100%" }} />
        </div>
      )}
    </div>
  );
}
