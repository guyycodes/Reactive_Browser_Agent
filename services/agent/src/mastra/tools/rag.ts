import pRetry, { AbortError } from "p-retry";
import { z } from "zod";

import { env } from "../../env.js";
import { logger } from "../../logger.js";

/**
 * HTTP client for the `rag` FastAPI service's QA retrieval endpoint.
 *
 * Contract
 * --------
 * - Calls `POST ${env.RAG_URL}/docs/models/qa` with
 *   `{ query, collection_name }` and the Commit-5-prep response shape
 *   (`{ docs, hits, request_id, elapsed_seconds }`). Validates the response
 *   with Zod at the tool boundary — malformed bodies throw `RagSchemaError`
 *   before any workflow step sees them.
 *
 * - Retry policy (via `p-retry`): exponential backoff with `minTimeout=500 ms`,
 *   `factor=2`, `maxTimeout=15 s`, `randomize=true`. An `AbortSignal` enforces
 *   an overall 90 s deadline regardless of attempt count, matching the
 *   `agent` → `rag` `service_started`-not-`service_healthy` window in
 *   ARCHITECTURE §5. Retries trigger on network errors + 5xx + 408 + 429;
 *   other 4xx bail immediately via `AbortError`.
 *
 * - Collection missing (HTTP 404) is NOT a retry trigger and NOT a user-facing
 *   error. It resolves to `{ docs: [], hits: [], request_id, elapsed_seconds }`
 *   so the workflow can keep moving — a ticket asking about something we've
 *   never ingested runbooks for is semantically "no context," not "failure."
 *
 * - Sentinel filtering: with the patched rag image, `hits: []` is the
 *   authoritative empty signal. For belt-and-suspenders against an old rag
 *   image where `docs: ["No relevant context found."]` arrives without a
 *   `hits` key, the Zod schema rejects that response as a schema violation
 *   (making the dev's upgrade gap visible instead of silently emitting a
 *   sentinel string as a "hit"). Real sentinel strings on the hits-empty
 *   path are preserved in the returned `docs` — callers downstream of this
 *   function may choose to hide them.
 *
 * This file emits NO envelope frames. The workflow's `retrieveStep` owns
 * `tool.started` / `rag.retrieved` / `tool.completed` timing so frame emission
 * stays synchronized with Mastra step boundaries.
 */

/** ---------- Error taxonomy ---------- */

export class RagClientError extends Error {
  public readonly status?: number;
  public override readonly cause?: unknown;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = "RagClientError";
    this.status = status;
    this.cause = cause;
  }
}

export class RagSchemaError extends Error {
  public readonly issues: readonly z.ZodIssue[];
  constructor(message: string, issues: readonly z.ZodIssue[]) {
    super(message);
    this.name = "RagSchemaError";
    this.issues = issues;
  }
}

/** Internal signal: the target collection doesn't exist in Qdrant yet.
 *  Not exported — callers observe the empty-result shape instead. */
class MissingCollectionError extends Error {
  public readonly collection: string;
  constructor(collection: string) {
    super(`rag collection '${collection}' not found`);
    this.name = "MissingCollectionError";
    this.collection = collection;
  }
}

/** ---------- Schemas ---------- */

const ragHitSchema = z.object({
  id: z.string(),
  score: z.number(),
  text: z.string(),
  source: z.string().nullable(),
  chunk_id: z.number().int().nonnegative().nullable(),
});

const qaResponseSchema = z.object({
  docs: z.array(z.string()),
  hits: z.array(ragHitSchema),
  request_id: z.string(),
  elapsed_seconds: z.number(),
});

export type RagHit = z.infer<typeof ragHitSchema>;
export type QaResponse = z.infer<typeof qaResponseSchema>;

/** ---------- Retry + deadline config ---------- */

export const DEFAULT_RETRY_CONFIG = {
  retries: 8,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 15_000,
  randomize: true,
  deadlineMs: 90_000,
} as const;

export type RetrieveOptions = {
  /** External cancellation. If it aborts, the in-flight fetch + retry loop
   *  are both torn down and the function rejects with `RagClientError`. */
  signal?: AbortSignal;
  /** Test-only overrides. Not intended for production callers. */
  fetchImpl?: typeof fetch;
  ragUrl?: string;
  retryConfig?: Partial<typeof DEFAULT_RETRY_CONFIG>;
};

/** ---------- Core retrieval ---------- */

/** Retrieve from a specific Qdrant collection UUID. Exported so the unit test
 *  can hit arbitrary collections without touching `env`. */
export async function retrieveFromCollection(
  query: string,
  collectionUuid: string,
  opts: RetrieveOptions = {},
): Promise<QaResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ragUrl = opts.ragUrl ?? env.RAG_URL;
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...(opts.retryConfig ?? {}) };

  // Combine external cancellation with the overall deadline. Either source
  // aborts both the fetch and the inter-attempt sleep inside p-retry.
  const controller = new AbortController();
  const deadlineTimer: NodeJS.Timeout = setTimeout(() => {
    controller.abort(new Error(`rag_deadline_${cfg.deadlineMs}ms_exceeded`));
  }, cfg.deadlineMs);
  // Don't keep the event loop alive just for this timer.
  if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();

  const onExternalAbort = (): void => {
    const reason = opts.signal?.reason;
    controller.abort(reason instanceof Error ? reason : new Error(String(reason ?? "external_abort")));
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onExternalAbort();
    } else {
      opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const url = `${ragUrl}/docs/models/qa`;
  const body = JSON.stringify({ query, collection_name: collectionUuid });

  const doFetch = async (attempt: number): Promise<QaResponse> => {
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // Abort-triggered fetch rejection → non-retryable. The outer catch
      // translates this into a RagClientError with the abort reason.
      if (controller.signal.aborted) {
        throw new AbortError(
          new RagClientError(
            `rag fetch aborted: ${String(controller.signal.reason ?? "unknown")}`,
            undefined,
            err,
          ),
        );
      }
      // Genuine network error (ECONNREFUSED, DNS, etc.) → retryable.
      throw new RagClientError(
        `rag fetch network error on attempt ${attempt}: ${(err as Error).message}`,
        undefined,
        err,
      );
    }

    if (resp.status === 404) {
      // Empty-result signal. Bail the retry loop cleanly.
      throw new AbortError(new MissingCollectionError(collectionUuid));
    }
    if (resp.status === 408 || resp.status === 429) {
      // Retry-worthy 4xx (timeout, rate-limit).
      const detail = await safeReadText(resp);
      throw new RagClientError(
        `rag ${resp.status} on attempt ${attempt}: ${detail}`,
        resp.status,
      );
    }
    if (resp.status >= 400 && resp.status < 500) {
      // Client-side bug — retrying won't help.
      const detail = await safeReadText(resp);
      throw new AbortError(
        new RagClientError(
          `rag ${resp.status} on attempt ${attempt}: ${detail}`,
          resp.status,
        ),
      );
    }
    if (resp.status >= 500) {
      const detail = await safeReadText(resp);
      throw new RagClientError(
        `rag ${resp.status} on attempt ${attempt}: ${detail}`,
        resp.status,
      );
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      throw new AbortError(
        new RagClientError(
          `rag response body is not valid JSON on attempt ${attempt}`,
          resp.status,
          err,
        ),
      );
    }

    const parsed = qaResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AbortError(
        new RagSchemaError(
          `rag response failed schema validation (attempt ${attempt})`,
          parsed.error.issues,
        ),
      );
    }
    return parsed.data;
  };

  try {
    return await pRetry(doFetch, {
      retries: cfg.retries,
      factor: cfg.factor,
      minTimeout: cfg.minTimeout,
      maxTimeout: cfg.maxTimeout,
      randomize: cfg.randomize,
      signal: controller.signal,
      onFailedAttempt: (err) => {
        logger.warn(
          {
            attempt: err.attemptNumber,
            retriesLeft: err.retriesLeft,
            err: err.message,
            collection: collectionUuid,
          },
          "[rag] retry attempt failed",
        );
      },
    });
  } catch (err) {
    // Translate the internal "collection missing" signal into the
    // empty-result envelope so callers don't have to special-case it.
    if (err instanceof MissingCollectionError) {
      return {
        docs: [],
        hits: [],
        request_id: "rag-missing-collection",
        elapsed_seconds: 0,
      };
    }
    // p-retry surfaces its own AbortError when `signal` fires during a
    // sleep window. Normalize all "aborted / deadline / exhausted" endings
    // into a RagClientError so callers have one error type to catch.
    if (err instanceof RagClientError || err instanceof RagSchemaError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RagClientError(
      `rag retrieval failed: ${message}`,
      undefined,
      err,
    );
  } finally {
    clearTimeout(deadlineTimer);
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** Retrieve from the shared runbooks collection (env.SHARED_RUNBOOKS_UUID). */
export async function retrieveRunbooks(
  query: string,
  opts: RetrieveOptions = {},
): Promise<QaResponse> {
  return retrieveFromCollection(query, env.SHARED_RUNBOOKS_UUID, opts);
}

/** Retrieve from the shared skill-cards collection (env.SHARED_SKILLS_UUID). */
export async function retrieveSkills(
  query: string,
  opts: RetrieveOptions = {},
): Promise<QaResponse> {
  return retrieveFromCollection(query, env.SHARED_SKILLS_UUID, opts);
}

/**
 * Week-2b-foundation — targeted skill-card retrieval for ReAct classify/plan.
 *
 * Both entrypoints compose a category-hint / intent-hint prefix onto the
 * caller's query before hitting the same `SHARED_SKILLS_UUID` collection
 * `retrieveSkills` uses. The prefix biases Qdrant's similarity ranking
 * toward skill-card prose matching the classifier's current category
 * guess (or the planner's declared intent).
 *
 * These functions are NOT wired into any workflow step in foundation —
 * they exist so `week2c-react-classify` and `week2c-react-plan` can
 * register them as ReAct tools without further `rag.ts` edits. The 2c
 * commits wrap these with `tool.started` / `rag.retrieved` /
 * `tool.completed` frame emissions at the ReAct registration site (see
 * `retrieveStep` in `triage.ts` for the pattern).
 *
 * Error taxonomy (`RagClientError` / `RagSchemaError`) + 404→empty-hits
 * translation + circuit-breaker retry behavior carry through from
 * `retrieveFromCollection` unchanged.
 */

/** ReAct-classify tool: retrieve skill-card hints biased toward a category. */
export async function retrieveCategoryHints(
  category: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<QaResponse> {
  const composedQuery = `Category: ${category}. ${query}`;
  return retrieveFromCollection(composedQuery, env.SHARED_SKILLS_UUID, opts);
}

/** ReAct-plan tool: retrieve skill-cards matching a declared intent. */
export async function retrieveSkillCardsByIntent(
  intent: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<QaResponse> {
  const composedQuery = `Intent: ${intent}. ${query}`;
  return retrieveFromCollection(composedQuery, env.SHARED_SKILLS_UUID, opts);
}

/** ---------- Helpers ---------- */

async function safeReadText(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<unreadable body>";
  }
}
