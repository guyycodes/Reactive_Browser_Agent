import { describe, it, expect } from "vitest";

import {
  retrieveFromCollection,
  retrieveCategoryHints,
  retrieveSkillCardsByIntent,
  RagClientError,
  RagSchemaError,
  DEFAULT_RETRY_CONFIG,
  type QaResponse,
} from "../src/mastra/tools/rag.js";

/**
 * Commit 5a unit coverage for the RAG HTTP client.
 *
 * Scope (per reviewer handoff):
 *   1. Happy path             — 200 + full payload → Zod passes, 1 call.
 *   2. Empty-sentinel path    — 200 + `hits: []` + sentinel docs → as-is, 1 call.
 *   3. Missing-collection     — 404 → empty result envelope, 1 call, no retry.
 *   4. Retry-on-5xx-success   — 503 → 503 → 200 → 3 calls, resolves under 2 s.
 *   5. Deadline-hit           — sustained 503 past `deadlineMs` → RagClientError.
 *   6. (Bonus) schema violation — 200 with malformed body → RagSchemaError, 1 call.
 *
 * We inject a mock `fetchImpl` rather than patching the global dispatcher;
 * that keeps the test dependency-free (no `undici`, no `msw`) and gives full
 * control over call counts + response timing. Retry delays are compressed
 * by overriding `retryConfig.minTimeout` / `maxTimeout` / `deadlineMs` so the
 * suite stays fast.
 */

const TEST_COLLECTION = "d96b439c-5e3d-4e25-9790-f2235ffffe26";
const TEST_RAG_URL = "http://rag.test:3009";

type MockFetch = {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a mock fetch that pulls from a queue, then falls back to `fallback`
 *  (or throws if no fallback provided and the queue is exhausted). */
function makeMockFetch(
  queue: Array<() => Response>,
  fallback?: () => Response,
): MockFetch {
  const calls: MockFetch["calls"] = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next) return next();
    if (fallback) return fallback();
    throw new Error("[mock-fetch] queue exhausted and no fallback provided");
  };
  return { fetch: fn, calls };
}

const happyBody = {
  docs: [
    "passage: Password Reset — Internal Admin Portal. Confirm identity before any reset.",
  ],
  hits: [
    {
      id: "f61c3add-44da-453a-b5e3-96f8910598f3",
      score: 0.877,
      text: "passage: Password Reset — Internal Admin Portal. Confirm identity before any reset.",
      source: "/app/src/util/clean_docs/abc/finished.txt",
      chunk_id: 0,
    },
  ],
  request_id: "QA-abcdef",
  elapsed_seconds: 1.35,
};

/** Compressed retry config used by every test so the suite stays under ~3 s. */
const FAST_RETRY = {
  retries: 4,
  factor: 2,
  minTimeout: 10,
  maxTimeout: 50,
  randomize: false,
  deadlineMs: 2_000,
} as const;

describe("rag client — retrieveFromCollection", () => {
  it("[1] happy path: 200 + populated hits → Zod validates, one call", async () => {
    const mock = makeMockFetch([() => jsonResponse(200, happyBody)]);

    const result = await retrieveFromCollection("reset password", TEST_COLLECTION, {
      fetchImpl: mock.fetch,
      ragUrl: TEST_RAG_URL,
      retryConfig: FAST_RETRY,
    });

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.url).toBe(`${TEST_RAG_URL}/docs/models/qa`);

    const sentBody = JSON.parse(String(mock.calls[0]?.init?.body));
    expect(sentBody).toEqual({
      query: "reset password",
      collection_name: TEST_COLLECTION,
    });

    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.id).toBe("f61c3add-44da-453a-b5e3-96f8910598f3");
    expect(result.hits[0]?.score).toBeCloseTo(0.877);
    expect(result.hits[0]?.source).toBe("/app/src/util/clean_docs/abc/finished.txt");
    expect(result.hits[0]?.chunk_id).toBe(0);
    expect(result.docs.length).toBe(1);
    expect(result.request_id).toBe("QA-abcdef");
  });

  it("[2] empty sentinel: 200 + hits:[] + sentinel doc string → returned as-is, one call, no retry", async () => {
    const sentinelBody: QaResponse = {
      docs: ["No relevant context found."],
      hits: [],
      request_id: "QA-empty1",
      elapsed_seconds: 0.1,
    };
    const mock = makeMockFetch([() => jsonResponse(200, sentinelBody)]);

    const result = await retrieveFromCollection("nonsense", TEST_COLLECTION, {
      fetchImpl: mock.fetch,
      ragUrl: TEST_RAG_URL,
      retryConfig: FAST_RETRY,
    });

    expect(mock.calls.length).toBe(1);
    expect(result.hits).toEqual([]);
    // Sentinel docs string is passed through verbatim — the workflow layer
    // decides whether to hide it; the tool client does not re-interpret 200s.
    expect(result.docs).toEqual(["No relevant context found."]);
    expect(result.request_id).toBe("QA-empty1");
  });

  it("[3] missing collection: 404 → empty-result envelope, one call, no retry", async () => {
    const mock = makeMockFetch([
      () =>
        jsonResponse(404, {
          detail: `Collection '${TEST_COLLECTION}' not found in Qdrant.`,
        }),
    ]);

    const result = await retrieveFromCollection("anything", TEST_COLLECTION, {
      fetchImpl: mock.fetch,
      ragUrl: TEST_RAG_URL,
      retryConfig: FAST_RETRY,
    });

    expect(mock.calls.length).toBe(1);
    expect(result.docs).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.request_id).toBe("rag-missing-collection");
    expect(result.elapsed_seconds).toBe(0);
  });

  it("[4] retry-on-5xx-success: 503 → 503 → 200 → three calls, resolves under 2 s", async () => {
    const mock = makeMockFetch([
      () => jsonResponse(503, { detail: "rag warming up" }),
      () => jsonResponse(503, { detail: "rag warming up" }),
      () => jsonResponse(200, happyBody),
    ]);

    const started = Date.now();
    const result = await retrieveFromCollection("reset password", TEST_COLLECTION, {
      fetchImpl: mock.fetch,
      ragUrl: TEST_RAG_URL,
      retryConfig: FAST_RETRY,
    });
    const elapsed = Date.now() - started;

    expect(mock.calls.length).toBe(3);
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.id).toBe("f61c3add-44da-453a-b5e3-96f8910598f3");
    expect(elapsed).toBeLessThan(2_000);
  });

  it("[5] deadline hit: sustained 503 past deadlineMs → throws RagClientError", async () => {
    const mock = makeMockFetch([], () =>
      jsonResponse(503, { detail: "rag still warming up" }),
    );

    await expect(
      retrieveFromCollection("reset password", TEST_COLLECTION, {
        fetchImpl: mock.fetch,
        ragUrl: TEST_RAG_URL,
        retryConfig: {
          ...FAST_RETRY,
          // Enough room for multiple attempts, but well under the suite
          // timeout so a genuine deadline miss surfaces as a test failure.
          deadlineMs: 300,
          minTimeout: 30,
          maxTimeout: 60,
          retries: 50, // large — we want the DEADLINE to be the bound, not attempt count
        },
      }),
    ).rejects.toBeInstanceOf(RagClientError);

    // At least two attempts must have been made before the deadline kicked in.
    // (With minTimeout=30, attempts 1+2 are bracketed by ~30 ms of sleep;
    // deadline=300 ms leaves comfortable room for more.)
    expect(mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("[6] schema violation: 200 OK with malformed body → throws RagSchemaError, one call, no retry", async () => {
    // Old rag image shape (pre-Commit-5-prep): no `hits` key.
    const mock = makeMockFetch([
      () =>
        jsonResponse(200, {
          docs: ["passage: whatever"],
          request_id: "QA-legacy",
          elapsed_seconds: 0.2,
          // hits missing
        }),
    ]);

    await expect(
      retrieveFromCollection("reset password", TEST_COLLECTION, {
        fetchImpl: mock.fetch,
        ragUrl: TEST_RAG_URL,
        retryConfig: FAST_RETRY,
      }),
    ).rejects.toBeInstanceOf(RagSchemaError);

    expect(mock.calls.length).toBe(1);
  });
});

describe("rag client — exported defaults", () => {
  it("DEFAULT_RETRY_CONFIG matches the ARCHITECTURE §5 budget", () => {
    // Keep the contract stable: if these change, the 90 s boot window note
    // in ARCHITECTURE §5 must be revisited.
    expect(DEFAULT_RETRY_CONFIG.minTimeout).toBe(500);
    expect(DEFAULT_RETRY_CONFIG.maxTimeout).toBe(15_000);
    expect(DEFAULT_RETRY_CONFIG.factor).toBe(2);
    expect(DEFAULT_RETRY_CONFIG.randomize).toBe(true);
    expect(DEFAULT_RETRY_CONFIG.deadlineMs).toBe(90_000);
  });
});

/**
 * Week-2b foundation — targeted skill-card retrieval tools.
 *
 * These two tools delegate to `retrieveFromCollection` with a composed
 * query prefix ("Category: X. ..." / "Intent: X. ...") and the
 * `env.SHARED_SKILLS_UUID` collection. Tests verify:
 *   [N]   `retrieveCategoryHints` composes the Category prefix and
 *         routes to SHARED_SKILLS_UUID.
 *   [N+1] `retrieveSkillCardsByIntent` composes the Intent prefix and
 *         routes to SHARED_SKILLS_UUID.
 *   [N+2] Both translate 404 → empty-hits envelope (delegation check —
 *         `retrieveFromCollection`'s existing [3] test already guards
 *         the underlying mechanism; this test guards that the new
 *         wrappers preserve it).
 *
 * Setup (`test/setup.ts`) seeds `SHARED_SKILLS_UUID` to a canonical
 * UUID4 so `env.SHARED_SKILLS_UUID` resolves at rag.ts import time.
 * The expected collection_name in the sent body matches that value.
 */
const EXPECTED_SKILLS_UUID = "08de373f-ca2d-4e49-8ca9-5ff799ae5d40";

describe("rag client — targeted skill-card retrieval tools (Week-2b foundation)", () => {
  it("[7] retrieveCategoryHints composes 'Category: X. Y' prefix and routes to SHARED_SKILLS_UUID", async () => {
    const mock = makeMockFetch([() => jsonResponse(200, happyBody)]);

    const result = await retrieveCategoryHints(
      "account_access",
      "locked user needs help",
      {
        fetchImpl: mock.fetch,
        ragUrl: TEST_RAG_URL,
        retryConfig: FAST_RETRY,
      },
    );

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.url).toBe(`${TEST_RAG_URL}/docs/models/qa`);

    const sentBody = JSON.parse(String(mock.calls[0]?.init?.body));
    expect(sentBody).toEqual({
      query: "Category: account_access. locked user needs help",
      collection_name: EXPECTED_SKILLS_UUID,
    });

    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.id).toBe("f61c3add-44da-453a-b5e3-96f8910598f3");
  });

  it("[8] retrieveSkillCardsByIntent composes 'Intent: X. Y' prefix and routes to SHARED_SKILLS_UUID", async () => {
    const mock = makeMockFetch([() => jsonResponse(200, happyBody)]);

    const result = await retrieveSkillCardsByIntent(
      "reset_password",
      "jane has forgotten her password",
      {
        fetchImpl: mock.fetch,
        ragUrl: TEST_RAG_URL,
        retryConfig: FAST_RETRY,
      },
    );

    expect(mock.calls.length).toBe(1);
    const sentBody = JSON.parse(String(mock.calls[0]?.init?.body));
    expect(sentBody).toEqual({
      query: "Intent: reset_password. jane has forgotten her password",
      collection_name: EXPECTED_SKILLS_UUID,
    });

    expect(result.hits.length).toBe(1);
  });

  it("[9] both tools translate 404 → empty-hits envelope (delegation guard)", async () => {
    // retrieveCategoryHints + 404
    const mockA = makeMockFetch([
      () =>
        jsonResponse(404, {
          detail: `Collection '${EXPECTED_SKILLS_UUID}' not found in Qdrant.`,
        }),
    ]);
    const resultA = await retrieveCategoryHints("anything", "query", {
      fetchImpl: mockA.fetch,
      ragUrl: TEST_RAG_URL,
      retryConfig: FAST_RETRY,
    });
    expect(mockA.calls.length).toBe(1);
    expect(resultA.hits).toEqual([]);
    expect(resultA.docs).toEqual([]);
    expect(resultA.request_id).toBe("rag-missing-collection");

    // retrieveSkillCardsByIntent + 404
    const mockB = makeMockFetch([
      () =>
        jsonResponse(404, {
          detail: `Collection '${EXPECTED_SKILLS_UUID}' not found in Qdrant.`,
        }),
    ]);
    const resultB = await retrieveSkillCardsByIntent("anything", "query", {
      fetchImpl: mockB.fetch,
      ragUrl: TEST_RAG_URL,
      retryConfig: FAST_RETRY,
    });
    expect(mockB.calls.length).toBe(1);
    expect(resultB.hits).toEqual([]);
    expect(resultB.docs).toEqual([]);
    expect(resultB.request_id).toBe("rag-missing-collection");
  });
});
