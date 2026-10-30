import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { SessionDeps } from "./policy.js";

/** D09: heartbeat 15 s, expiry 90 s. A lost tab frees the lease; the session itself stays resumable. */
export const HEARTBEAT_SECONDS = 15;
export const LEASE_SECONDS = 90;

export interface Lease {
  token: number;
  expiresAt: string;
}

/** Take or refresh the practice lease for a tab. A second tab with a live lease held elsewhere gets a 409 (read-only resume). */
export function takeLease(db: Db, deps: SessionDeps, sessionId: string, tabId: string): Lease {
  return db
    .transaction((): Lease => {
      const s = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
      if (!s) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
      if (s.status !== "active") throw new ApiError(409, "SESSION_NOT_ACTIVE", "Session is not active");
      const now = deps.now();
      const expires = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
      const cur = db.prepare("SELECT tab_id AS tabId, token, expires_at AS expiresAt FROM practice_leases WHERE session_id = ?").get(sessionId) as { tabId: string; token: number; expiresAt: string } | undefined;
      if (!cur) {
        db.prepare("INSERT INTO practice_leases(session_id, tab_id, token, heartbeat_at, expires_at) VALUES (?,?,?,?,?)").run(sessionId, tabId, 1, now.toISOString(), expires);
        return { token: 1, expiresAt: expires };
      }
      if (cur.tabId !== tabId && Date.parse(cur.expiresAt) > now.getTime()) {
        throw new ApiError(409, "LEASE_HELD", "Another tab is practising this session", { expiresAt: cur.expiresAt });
      }
      const token = cur.tabId === tabId ? cur.token : cur.token + 1; // a takeover bumps the fencing token
      db.prepare("UPDATE practice_leases SET tab_id = ?, token = ?, heartbeat_at = ?, expires_at = ? WHERE session_id = ?").run(tabId, token, now.toISOString(), expires, sessionId);
      return { token, expiresAt: expires };
    })
    .immediate();
}

export function assertLease(db: Db, deps: SessionDeps, sessionId: string, tabId: string): void {
  const cur = db.prepare("SELECT tab_id AS tabId, expires_at AS expiresAt FROM practice_leases WHERE session_id = ?").get(sessionId) as { tabId: string; expiresAt: string } | undefined;
  if (!cur || cur.tabId !== tabId || Date.parse(cur.expiresAt) <= deps.now().getTime()) {
    throw new ApiError(409, "LEASE_REQUIRED", "This tab does not hold the practice lease; take it first", { held: cur ? cur.tabId !== tabId && Date.parse(cur.expiresAt) > deps.now().getTime() : false });
  }
}
