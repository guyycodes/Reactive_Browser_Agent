import { Hono } from "hono";
import { env } from "../env.js";
import { rawClient } from "../db/client.js";
import { logger } from "../logger.js";

/**
 * GET /healthz — liveness for the agent itself and reachability probes for
 * its peers. The endpoint returns 200 only when every hard dependency
 * (postgres, qdrant, rag) is reachable. Transient failures are logged and
 * reflected in the JSON body so operators can see which peer is sick.
 *
 * Timeouts are aggressive (1.5s per peer) so a stuck dependency can't hang
 * the probe — the compose healthcheck must complete well under its
 * interval/timeout.
 */

const PEER_TIMEOUT_MS = 1500;

async function probe(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probePostgres(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const sql = rawClient();
    await sql`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function healthRouter(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const [qdrant, rag, pg] = await Promise.all([
      probe(`${env.QDRANT_URL}/readyz`),
      probe(`${env.RAG_URL}/monitor`),
      probePostgres(),
    ]);

    const allOk = qdrant.ok && rag.ok && pg.ok;
    const body = {
      status: allOk ? "ok" : "degraded",
      peers: { qdrant, rag, postgres: pg },
    };

    if (!allOk) {
      logger.warn({ peers: body.peers }, "[healthz] one or more peers unreachable");
    }
    return c.json(body, allOk ? 200 : 503);
  });

  return app;
}
