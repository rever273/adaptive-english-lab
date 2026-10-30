import type { FastifyInstance } from "fastify";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionBootstrap } from "@english-lab/contracts";
import { ApiError } from "./errors.js";

const COOKIE = "el_sid";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Local-service request protection for mutations (spec/11): a random per-start HttpOnly SameSite=Strict cookie plus a
 * CSRF header derived from it. Not a user account or login. A new server start invalidates every old cookie.
 */
export function registerCsrf(app: FastifyInstance, secret: Buffer = randomBytes(32)): void {
  const mac = (label: string, value: string) => createHmac("sha256", secret).update(`${label}:${value}`).digest("hex");
  const sign = (): string => {
    const rand = randomBytes(24).toString("hex");
    return `${rand}.${mac("sid", rand).slice(0, 32)}`;
  };
  const validSid = (sid: string | undefined): sid is string => {
    if (!sid) return false;
    const [rand, tag, extra] = sid.split(".");
    if (!rand || !tag || extra !== undefined) return false;
    const want = mac("sid", rand).slice(0, 32);
    return tag.length === want.length && timingSafeEqual(Buffer.from(tag), Buffer.from(want));
  };
  const readCookie = (header: string | undefined): string | undefined => {
    for (const part of (header ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return undefined;
  };

  // Bootstrap: same-origin JS fetches this once to obtain the CSRF value for its cookie.
  app.get("/api/v1/session", async (req, reply): Promise<SessionBootstrap> => {
    let sid = readCookie(req.headers.cookie);
    if (!validSid(sid)) {
      sid = sign();
      reply.header("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    }
    return { csrfToken: mac("csrf", sid) };
  });

  app.addHook("onRequest", async (req) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith("/api/v1/")) return;
    if (!req.headers.origin) throw new ApiError(403, "ORIGIN_REQUIRED", "Mutations require an Origin header");
    const sid = readCookie(req.headers.cookie);
    const given = String(req.headers["x-csrf-token"] ?? "");
    const ok = validSid(sid) && (() => {
      const want = mac("csrf", sid);
      return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
    })();
    if (!ok) throw new ApiError(403, "CSRF_FAILED", "Missing or invalid session cookie / CSRF token");
  });
}
