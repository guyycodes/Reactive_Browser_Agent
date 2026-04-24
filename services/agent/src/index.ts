import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { EventBus } from "./events/bus.js";
import { isOriginAllowed, openStream } from "./events/stream.js";
import { makePersister } from "./events/persist.js";
import { db, closeDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { healthRouter } from "./http/health.js";
import { triageRouter } from "./http/triage.js";
import { runsRouter } from "./http/runs.js";
import { staticRouter } from "./http/static.js";
import type { StreamSession } from "./events/stream.js";

/**
 * Agent service entrypoint. Commit 1 wires:
 *   - Boot-time migrations
 *   - HTTP routers: /healthz, /triage, /runs/*
 *   - WS route:    /stream/:runId with origin allowlist
 *   - Graceful shutdown: drain HTTP, close DB pool
 *
 * Commit 2 layers the Mastra workflow + Anthropic streamMapper onto this bus.
 * Nothing in the transport / persistence / HTTP surface changes at that point.
 */

async function main(): Promise<void> {
  logger.info(
    {
      port: env.PORT,
      pg: env.PG_URL.replace(/\/\/[^@]+@/, "//***@"),
      rag: env.RAG_URL,
      qdrant: env.QDRANT_URL,
      allowedOrigins: env.ALLOWED_WS_ORIGINS,
    },
    "[agent] booting",
  );

  await runMigrations();

  const bus = new EventBus({ ringBufferSize: env.EVENT_RING_BUFFER_SIZE });
  bus.onPersist = makePersister(db);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.route("/healthz", healthRouter());
  app.route("/triage", triageRouter({ bus, db }));
  app.route("/runs", runsRouter({ bus, db }));
  // 6c-2: serve per-run screenshots from the `playwright-videos` volume so
  // the reviewer UI can render `<img>` inline in the timeline. The mount
  // prefix matches the frame emitter's absolute path layout
  // (`/workspace/.playwright-videos/<runId>/<seq>.png`).
  app.route("/static", staticRouter({ runsRoot: "/workspace/.playwright-videos" }));

  // Origin allowlist on WS upgrade. Middleware runs before upgradeWebSocket's
  // handlers; returning a response here prevents the upgrade entirely.
  app.use("/stream/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!isOriginAllowed(origin, env.ALLOWED_WS_ORIGINS)) {
      logger.info(
        { origin: origin ?? null, path: c.req.path },
        "[ws] upgrade rejected: origin not allowed",
      );
      return c.text("Origin not allowed", 403);
    }
    await next();
  });

  app.get(
    "/stream/:runId",
    upgradeWebSocket((c) => {
      // The route pattern guarantees a runId at runtime, but Hono's param()
      // signature is string | undefined. Guard explicitly so TS narrows and
      // a mis-registered route would crash loudly rather than silently carry
      // `undefined` into openStream.
      const runId = c.req.param("runId");
      if (!runId) {
        throw new Error("Unreachable: /stream/:runId upgrade with no runId param");
      }
      let session: StreamSession | null = null;

      return {
        onOpen(_evt, ws) {
          session = openStream({
            bus,
            runId,
            sender: {
              get isOpen() {
                // hono/node-ws WSContext exposes `readyState` on the underlying raw.
                return ws.readyState === 1; // OPEN
              },
              send(data: string) {
                ws.send(data);
              },
              close(code, reason) {
                ws.close(code, reason);
              },
            },
            resolveClientIdentity: () => "anonymous",
          });
          logger.debug({ runId }, "[ws] opened");
        },
        onMessage(evt, _ws) {
          if (!session) return;
          const raw =
            typeof evt.data === "string" ? evt.data : evt.data.toString();
          session.onClientMessage(raw);
        },
        onClose(_evt) {
          session?.onClose();
          session = null;
          logger.debug({ runId }, "[ws] closed");
        },
        onError(evt) {
          logger.warn({ runId, evt }, "[ws] error");
        },
      };
    }),
  );

  const server = serve({ fetch: app.fetch, port: env.PORT });
  injectWebSocket(server);

  logger.info({ port: env.PORT }, "[agent] listening");

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "[agent] shutting down");
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb();
    } catch (err) {
      logger.error({ err }, "[agent] shutdown error");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "[agent] boot failed");
  process.exit(1);
});
