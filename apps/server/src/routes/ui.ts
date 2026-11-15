import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";

/**
 * Tab link. Every open page holds one small event stream to its own server: while it is open the tab is alive, and when the server stops the
 * browser reconnects by itself. `npm start` asks how many pages are connected after a restart so it can reuse the open tab instead of opening
 * another one; the page reloads itself once the new server answers, so it also picks up a new build. No data is sent - only a keep-alive comment.
 */
export function registerUiRoutes(app: FastifyInstance): void {
  const clients = new Set<ServerResponse>();
  /** the page that connected last owns the app: a page that was open before is told it was replaced (one tab only) */
  const owner = { res: null as ServerResponse | null, id: "" };

  app.get<{ Querystring: { id?: string } }>("/api/v1/ui/stream", (req, reply) => {
    const id = typeof req.query.id === "string" ? req.query.id.slice(0, 64) : "";
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    res.write("retry: 1500\n\n");
    // the same page reconnecting after a restart keeps its place; any other page takes over, and the others are told
    if (!(owner.id && id === owner.id)) for (const c of clients) if (c !== res) c.write("event: replaced\ndata: 1\n\n");
    owner.res = res;
    owner.id = id;
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
