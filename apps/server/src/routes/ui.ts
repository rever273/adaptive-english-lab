import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";

/**
 * Tab link. Every open page holds one small event stream to its own server: while it is open the tab is alive, and when the server stops the
 * browser reconnects by itself. `npm start` asks how many pages are connected after a restart so it can reuse the open tab instead of opening
 * another one; the page reloads itself once the new server answers, so it also picks up a new build. No data is sent - only a keep-alive comment.
 */
export function registerUiRoutes(app: FastifyInstance): void {
  const clients = new Set<ServerResponse>();

  app.get("/api/v1/ui/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    res.write("retry: 1500\n\n");
    clients.add(res);
    const timer = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    const gone = () => {
      clearInterval(timer);
      clients.delete(res);
    };
    req.raw.on("close", gone);
    res.on("close", gone);
  });

  app.get("/api/v1/ui/clients", async () => ({ open: clients.size }));

  // end the streams before the server stops, so a shutdown never waits for a page
  app.addHook("preClose", async () => {
    for (const c of clients) c.end();
    clients.clear();
  });
}
