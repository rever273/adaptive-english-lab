import type { Capabilities, Health } from "@english-lab/contracts";
import { useEffect, useState } from "react";
import { fetchCapabilities, fetchHealth } from "../api";

type State = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; health: Health; capabilities: Capabilities };

const COMPONENT_LABEL: Record<string, string> = { not_implemented: "Not implemented yet", unavailable: "Unavailable", ready: "Ready" };

export function Status() {
  const [state, setState] = useState<State>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchHealth(), fetchCapabilities()])
      .then(([health, capabilities]) => !cancelled && setState({ phase: "ready", health, capabilities }))
      .catch((e: unknown) => !cancelled && setState({ phase: "error", message: e instanceof Error ? e.message : "Unknown error" }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") return <p role="status">Checking the local server…</p>;
  if (state.phase === "error") {
    return (
      <section className="card card-error" role="alert">
        <h2>Server not reachable</h2>
        <p>{state.message}</p>
        <p>Start it again with <code>npm start</code>. Nothing you do here is saved until the server is running.</p>
      </section>
    );
  }
  const { health, capabilities } = state;
  return (
    <>
      <section className="card" aria-labelledby="status-h">
        <h2 id="status-h">Status</h2>
        <dl>
          <dt>Server</dt>
          <dd>
            <span className={`badge ${health.status === "ok" ? "badge-ok" : "badge-warn"}`}>{health.status === "ok" ? "OK" : "Degraded"}</span>
            {health.degradedReasons.length > 0 && <span className="muted"> ({health.degradedReasons.join(", ")})</span>}
          </dd>
          <dt>Database</dt>
          <dd>{health.db.ready ? "Ready" : "Unavailable"}, schema v{health.db.schemaVersion}</dd>
          <dt>SQLite</dt>
          <dd>
            {health.db.sqliteVersion} via {health.db.driver} {health.db.driverVersion}; journal {health.db.pragmas.journal_mode}, foreign keys {health.db.pragmas.foreign_keys ? "on" : "off"}, JSON {health.db.jsonSupport ? "supported" : "missing"}
          </dd>
          <dt>Runtime</dt>
          <dd>Node {health.node.version}, app {health.appVersion}</dd>
        </dl>
      </section>
      <section className="card" aria-labelledby="cap-h">
        <h2 id="cap-h">Capabilities</h2>
        <dl>
          <dt>Local language models (Ollama)</dt>
          <dd>{COMPONENT_LABEL[capabilities.ai.ollama]}</dd>
          <dt>Speech recognition (STT)</dt>
          <dd>{COMPONENT_LABEL[capabilities.stt.status]}</dd>
        </dl>
        <p className="muted">Typing is the only input for now. No audio is recorded or stored.</p>
      </section>
    </>
  );
}
