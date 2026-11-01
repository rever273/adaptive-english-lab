import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { ApiError } from "./errors.js";

/**
 * Local-service guard (spec/11): exact Host, exact Origin and Fetch-Metadata checks against
 * DNS rebinding and drive-by requests from other sites. This is not user authentication;
 * cookie + CSRF header for mutations arrive with the first mutating domain endpoint.
 */
export function registerSecurity(app: FastifyInstance, config: Pick<AppConfig, "port" | "devOrigin">): void {
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  if (config.devOrigin) origins.add(config.devOrigin);

  app.addHook("onRequest", async (req) => {
    const host = req.headers.host?.toLowerCase();
    if (!host || !hosts.has(host)) {
      throw new ApiError(403, "FORBIDDEN_HOST", "Host header is not an allowed loopback host");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      throw new ApiError(403, "FORBIDDEN_ORIGIN", "Origin is not allowed");
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      // A dev-origin page is cross-site for the browser; allow it only when its Origin was explicitly allowed above.
      const devOk = config.devOrigin !== null && origin !== undefined && origin.toLowerCase() === config.devOrigin;
      if (!devOk) throw new ApiError(403, "FORBIDDEN_FETCH_SITE", "Cross-site requests are not allowed");
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (req.url.startsWith("/api/") || req.url.startsWith("/internal/")) reply.header("Cache-Control", "no-store");
    return payload;
  });
}
