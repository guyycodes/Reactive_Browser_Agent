# Startup & Publishing Runbook

Every command you need to run, inspect, tear down, and publish the stack. Copy-paste friendly; assumes cwd is the repo root unless noted.

Related: [`ARCHITECTURE.md`](./ARCHITECTURE.md) for topology, [`README.md`](./README.md) for a higher-level tour.

---

## 1. Local — start the stack

```bash
# One-time: fill in keys
cp .env.example .env
$EDITOR .env

# Build all images (first time: ~10–15 min on a clean machine; cached after)
docker compose build

# Start everything detached, wait until the aggregator reports healthy
docker compose up -d --wait

# Quick confirmation: 6 rows, health columns all green
docker compose ps
```

Expected final state (7 services):

```
SERVICE                STATUS                PORTS
agent                  Up                    0.0.0.0:3001->3001/tcp, 0.0.0.0:9229->9229/tcp
browser-viewer         Up                    0.0.0.0:6080->6080/tcp
postgres               Up (healthy)          0.0.0.0:5432->5432/tcp
qdrant                 Up (healthy)          0.0.0.0:6333-6334->6333-6334/tcp
rag                    Up (healthy)          0.0.0.0:3009->3009/tcp
services-healthcheck   Up (healthy)
test-webapp            Up                    0.0.0.0:3000->3000/tcp
```

> First boot only: the `rag` service downloads `e5-large-v2-4096-lsg-patched` (~1–2 GB) into the named volume `hf-cache`. Subsequent boots skip the download. `docker compose up -d --wait` will block for up to 180s (the `rag` healthcheck `start_period`) during that first boot.

### Starting one service at a time

```bash
docker compose up -d qdrant postgres            # core infra first
docker compose up -d rag                        # then rag after they're healthy
docker compose up -d agent browser-viewer       # then the app layer
docker compose up -d services-healthcheck       # aggregator last
```

### Rebuild after a code/Dockerfile change

```bash
# Rebuild only what changed
docker compose build agent
docker compose up -d --force-recreate --no-deps agent

# Full stack rebuild with cache
docker compose build

# Force-rebuild from scratch (no cache)
docker compose build --no-cache
```

---

## 1.5 Manual walkthrough — test-webapp only (Week 1B part 1)

This is the operator's manual tour of the `test-webapp` service. It validates that the target app (what the agent will drive in Week 1B) and the reviewer UI both work **without** requiring the agent to be running any real workflow. You're exercising the Next.js app directly, the way a human would.

### Prerequisites

- Stack up: `docker compose up -d --wait` — all 7 services Up, five reporting `(healthy)`.
- Browser open at `http://localhost:3000/`.
- No `ANTHROPIC_API_KEY` needed for this walkthrough (we're not kicking off a run).

> **Important — agent Node server is NOT started automatically.** In Week 1A the `agent` container's `CMD` is `sleep infinity` (so VS Code can attach). The Hono HTTP/WS server must be started manually — see §1.5.0 below. Without it, port 3001 refuses connections and the reviewer UI's WebSocket fails.

### 1.5.0 Start the agent Node server (prerequisite for §1.5.3)

You only need this for the reviewer-UI subsection (§1.5.3). The target-app walkthrough (§1.5.2) works against test-webapp alone and does not need the agent server.

**Before you run the command below, confirm `.env` is complete.** The agent service reads `.env` at the repo root via `docker-compose.yml`'s `env_file:` directive. `src/env.ts` validates every required key with Zod and fails loud at boot if anything's missing. Minimum required keys for the agent to boot:

```
ANTHROPIC_API_KEY=<your key>
ANTHROPIC_MODEL_HAIKU=claude-haiku-4-5
ANTHROPIC_MODEL_SONNET=claude-sonnet-4-5
ANTHROPIC_MODEL_OPUS=claude-opus-4-5
SHARED_RUNBOOKS_UUID=<uuid from .env.example>
SHARED_SKILLS_UUID=<uuid from .env.example>
SHARED_SELECTORS_UUID=<uuid from .env.example>
ALLOWED_WS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:6080,http://127.0.0.1:6080,http://localhost:3001,http://127.0.0.1:3001
```

If any are missing, `npm run migrate` aborts with `[env] Invalid environment: <field>: Required`. The cleanest way to start: `cp .env.example .env` and fill in `ANTHROPIC_API_KEY` only; everything else in `.env.example` is already populated with the real deployment values.

After editing `.env`, recreate the agent container so compose picks up the new env:

```bash
docker compose up -d --force-recreate --no-deps agent
```

Open a **dedicated terminal** and run:

```bash
docker exec -it agent bash -lc '\
  cd /workspace/services/agent \
  && npm install \
  && npm run migrate \
  && npm run dev'
```

First time: ~45 s (npm install pulls the agent's deps; model cache volume on rag is already warm). Subsequent runs: ~5 s.

What happens:

1. `npm install` resolves `@mastra/core`, `@anthropic-ai/sdk`, Hono, Drizzle, etc.
2. `npm run migrate` applies `migrations/0001_init.sql` against Postgres (creates `runs`, `events`, `reviews` tables; idempotent — tracked in `_agent_migrations`).
3. `npm run dev` boots Hono + the WS upgrade on `:3001`, wired to the EventBus + persister. **Important: use `npm run dev`, NOT `npx tsx src/index.ts`.** The npm script is `tsx watch src/index.ts`, which reloads when files change under `src/`; plain `tsx` runs once and a later code edit leaves you staring at stale behavior during smoke tests (this caught us twice during Week 1B). If you've already started with plain `tsx`, verify hot-reload is live: `docker exec agent ps -eo pid,command | grep tsx` should show `tsx watch`, not `tsx src/index.ts`.

You'll see logs like:

```
[env] validated
[db] migrations applied
[agent] listening on :3001
```

Leave this terminal running. Ctrl-C stops the server (and the stack remains up).

**Verify from another terminal:**

```bash
curl -sS http://localhost:3001/healthz | python3 -m json.tool
# expect: { "status": "ok", "rag": "reachable", "qdrant": "reachable", "pg": "reachable" }
```

Only now is the reviewer UI's WebSocket target alive.

### 1.5.1 HTTP smoke (sanity — 10 s)

From the host terminal:

```bash
for route in /login /agent/review/fake-uuid-for-smoke; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$route")
  printf '%-40s HTTP %s\n' "$route" "$code"
done
# expect:
#   /login                                   HTTP 200
#   /agent/review/fake-uuid-for-smoke        HTTP 200

for route in /users /users/u003 /users/u003/reset-password /status; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$route")
  printf '%-40s HTTP %s\n' "$route" "$code"
done
# expect each route to return HTTP 307 (auth-gated; redirects to /login)
```

307 on the auth-gated routes is the correct behaviour — the session guard is working.

### 1.5.2 Target-app walkthrough (the "fake IT admin portal")

Everything below is **clicking through the browser as a human**. Every interactive element has a stable `data-testid`, so what you click is what Playwright will click in Week 1B.

1. **Land on the app.** Open `http://localhost:3000/` → redirects to `/login`.
2. **Sign in.** Email: `theo@example.com` · Password: anything (`demo`, `password`, etc.) → click **Sign in**. Lands on `/users`.
   - Any seeded email works. No password verification. The email is remembered in an httpOnly cookie for 1 hour.
3. **Browse users.** The `/users` table shows 20 seeded users. Badges show `active` / `locked` / `suspended`.
4. **Search.** Type `jane` into the search box → submit. The table filters to Jane Cooper (`locked` badge).
5. **Open Jane's detail.** Click the **View** link on Jane's row → `/users/u<id>`. You'll see:
   - `Status: locked` (amber badge)
   - `Last password reset: —` (never reset)
   - A **Reset password** call-to-action button.
6. **Reset the password.**
   - Click **Reset password** → lands on `/users/u<id>/reset-password`.
   - Tick the "I have verified the requester's identity…" checkbox (required — submit is disabled otherwise).
   - Click the **Reset password** button.
7. **Confirm the effect.** Page becomes a success view showing:
   - A green "Password reset successful" toast.
   - A **temporary password** in a monospace box (e.g. `Pw-aK9bQ2`). This is a demo artifact; real apps would one-shot it over email.
   - **Back to user** button → click it → `/users/u<id>`.
8. **Observe the state change.** Back on Jane's detail page:
   - `Status` is now `active` (green badge) — the reset unlocked her, matching real helpdesk behavior.
   - `Last password reset` is now a timestamp.
9. **Check system status.** Navigate to `/status` via the nav bar → 8 widgets (6 green, 1 amber = Directory Sync, 1 red = Billing Incident). Pure static content for 1B; Week 2's `check_system_status` skill will read this page.
10. **Sign out.** Nav bar → **Sign out** → back to `/login`. Session cookie cleared.

### 1.5.3 Reviewer UI walkthrough (stream consumer)

**Prerequisite: §1.5.0 must be running in another terminal** — the agent Node server has to be up for the WS at `:3001` to accept connections.

1. Make up a UUID: `python3 -c 'import uuid; print(uuid.uuid4())'`.
2. Open `http://localhost:3000/agent/review/<that-uuid>` in your browser.
3. You'll see:
   - Connection strip: flips to `open` (the WS accepts, exchanges a hello, and idles — since no run exists, no frames arrive).
   - Run badge: `unknown` (no `run.started` frame ever arrives).
   - Eight empty step cards in MASTER_PLAN §4 order: `classify → retrieve → plan → dry_run → review_gate → execute → verify → log_and_notify`.
4. No review panel appears (no `review.requested` frame), no thinking bubble, no events. That's correct.

**If the connection strip shows `closed` or the browser devtools console shows `WebSocket connection to 'ws://localhost:3001/stream/…' failed`:** §1.5.0 isn't running. Start the agent Node server in a dedicated terminal, then reload the page.

Full end-to-end reviewer UI with live frames requires a real run (`POST /triage`) and an `ANTHROPIC_API_KEY`. Not in scope for this walkthrough — that validation lands after Commit 5 wires real RAG retrieval.

### 1.5.4 Reset a user that's already been reset (idempotency sanity)

If you repeated step 6 above on the same user, you'd see a fresh `tempPassword` replace the old one and the `Last password reset` timestamp bump. There's no "already reset" guard — because real helpdesk flows often re-reset the same user in a day, and the agent's verify step expects to detect the state change via timestamp bump, not "was never reset."

### 1.5.5 Clean cookies / re-test as a different user

```bash
# Kill the session cookie the easy way:
# Browser devtools → Application → Cookies → localhost:3000 → delete "tw_session"
# Or in incognito / a fresh browser profile.
```

Seeded users to play with (every `email@example.com` works; any non-empty password):

| Who | Email | Starting status |
|---|---|---|
| Theo Chen | `theo@example.com` | active |
| **Jane Cooper** | **`jane@example.com`** | **locked** ← the reset-password demo target |
| Priya Iyer | `priya@example.com` | suspended |
| (17 others seeded) | — | mix |

### What this walkthrough proves

- The test-webapp container serves all Week-1B target routes with stable selectors.
- Session middleware correctly gates auth routes (307 when cold, 200 when signed in).
- The reset-password flow produces an **observable DOM state change** (status flip + timestamp) — exactly what the Week 1B agent's `verify` step will assert against.
- The reviewer UI loads and connects the WS even when the agent has no live run.

### What this walkthrough does NOT prove (later commits)

- ❌ Real Playwright driving these pages (Week 1B, Commit 6+).
- ❌ End-to-end `POST /triage` with real browser frames in the reviewer UI (needs Commits 6 + 7).

---

## 1.6 End-to-end `/triage` with real RAG + real browser (Week 1B, post-7b.iii.b commit 4)

As of week2d + week2e, the workflow is a **10-step chain with TWO human gates, 4 decision inputs per gate** + ephemeral-skill materialization + structured verify:

```
block1Step (classify → retrieve → plan → dry_run-AGENTIC-REACT, up to 3 passes)
  → reviewGateStep (PRE-EXEC GATE: approve / reject-replan / edit-replan / terminate)
  → materializeSkillCardStep (week2d Part 3b — actionTrace + boundaryReached
                              → ephemeral Skill → ctx.tempSkillCard + Postgres row)
  → executeStep (walks ctx.tempSkillCard; baseUrl from materialize)
  → verifyStep (week2d Part 3c — structured JSON over postconditions)
  → humanVerifyGateStep (POST-EXEC GATE: approve / reject-backtrack / terminate)
  → logAndNotifyStep
```

**POST /triage body** (week2e-dynamic-target-url):
```
{
  "ticketId":   string,
  "subject":    string,
  "submittedBy": string?,
  "targetUrl":   string?   // optional; http(s) only; overrides scaffold's base_url
}
```
Bad scheme → HTTP 400. See §13 "REVIEWER-CONTROL VIA EDIT-REFINE" in
`docs/Architecture.txt` for the reviewer-correction audit pattern.

**4-decision semantics** (Week-2a gate-decision-model):
- `approve` — proceed (unchanged).
- `reject` — replan without reviewer's notes. Pre-exec: refine loop with auto-generated directive seed observation ("Try a fundamentally different approach…"). Post-exec: backtrack loop (unchanged).
- `edit` — replan with reviewer's notes. Pre-exec only (post-exec treats edit ≡ approve; UI hides Edit).
- `terminate` — full-stop. Skip-cascade to `logAndNotifyStep` with `status=rejected`. Pre-exec: `runReviewGateStep` short-circuits. Post-exec: `humanVerifyGateStep` sets `skipped: true`. Pre-exec terminate cascades correctly through the post-exec gate via the entry skip-guard at `triage.ts:1976-1978` (hotfix-1).

Every step is real (except `log_and_notify` which still emits a minimal synthetic span — Week 2 polish). The workflow supports **human-guided meta-loops at both gates**: pre-exec Edit threads the reviewer's note into the next Block 1 pass (`MAX_PRE_GATE_REFINES = 2`, shared budget with Reject); post-exec Reject triggers a full `block1 → reviewGate → execute → verify` backtrack with carried observations (`MAX_BACKTRACKS = 2`). Both loops thread context via `runBlock1(..., { seedObservations: ... })` — NO `withRunContext({ ...ctx, priorObservations }, fn)` spread around `runBlock1` (CTX SPREAD INVARIANT in `runContext.ts`).

Runs are session-isolated: each spawn gets its own `--user-data-dir`; `runDryRunStep` pre-closes `ctx.browser` before each `launchBrowser` so intra-Block-1 multi-pass retries and refine/backtrack re-invocations don't collide on Playwright MCP's per-run profile lock.

> **Commit 7a landed (closes the 7a series).** The reviewer UI is a fixed-viewport two-column grid: LEFT is compact `<StepOutcome>` rows distilled from `step.completed.output` (uses `findLast` since 7b.iii.b commit 4, so refine/backtrack re-emissions update the LEFT column); RIGHT is a chronological `<BehaviorFeed>` with step dividers, streaming LLM bubbles (typewriter at 60 cps + thinking fade-to-summary on `llm.message.completed`), pulsing tool-call cards, inline 320×180 screenshot thumbnails, and a `scrollIntoView({block: "start"}) + scroll-margin-top: 33vh` anchor. A hand-rolled resizable divider between the columns persists its ratio to `localStorage`. `playwrightMcp.ts` fires an implicit `${mcpToolName}:after` screenshot after every successful `click` / `fillForm` (PNG count per happy-path run: ~12–15, was 6). See `ARCHITECTURE.md §2.7` for the full IA diagram.
>
> **7b.iii.b series landed (closes Week-1B).** Seven sub-commits + four hotfixes landed the full two-gate architecture: bus per-stepId decisions (`awaitDecisionForStep`), pre-exec refine loop with Edit UI (textarea, 2000-char cap, submitting mode with local escape hatch, planId-delta auto-exit), post-exec `humanVerifyGateStep` un-parked, `FeedBacktrackBanner` on every `block.backtrack.triggered` frame with pre-exec/post-exec copy variants, synthetic `block1 step.completed` frames on refine/backtrack for LEFT-column refresh, CTX SPREAD INVARIANT codified in `runContext.ts` docblock. See `docs/MASTER_PLAN.md` progress table + forensic audit table for the full bug chain (Bug A hid Bug B hid Bug 4; Bug 3A orthogonal).

The full chain depends on the rag collections actually having documents ingested. Without that, the runbook / skill queries return `hits: []` (not a failure; the workflow still finishes cleanly, but the reviewer UI shows zero retrieval evidence, which is uninteresting for a demo).

### 1.6.1 Prerequisite: ingest runbooks into the shared collection

The agent's `retrieveStep` queries `env.SHARED_RUNBOOKS_UUID` (set in `.env` and surfaced via `.env.example`). Drop the three HTML runbook fixtures into the `rag` watch volume with that UUID baked into their filenames — the `FileQueue` in rag routes them to the matching Qdrant collection via the filename-UUID convention (see the RAG collection semantics section in [`README.md`](./README.md)).

```bash
# Read SHARED_RUNBOOKS_UUID from your .env
UUID=$(grep '^SHARED_RUNBOOKS_UUID=' .env | cut -d= -f2)
test -n "$UUID" || { echo "SHARED_RUNBOOKS_UUID not set in .env"; exit 1; }

# Tag the three shipped fixtures with the shared UUID
SRC="$(pwd)/services/rag/test_fixtures/runbooks"
mkdir -p /tmp/runbook_tagged
cp "$SRC/password-reset.html"      "/tmp/runbook_tagged/password-reset_${UUID}.html"
cp "$SRC/unlock-account.html"      "/tmp/runbook_tagged/unlock-account_${UUID}.html"
cp "$SRC/system-status-check.html" "/tmp/runbook_tagged/system-status-check_${UUID}.html"

# Drop into the rag-dirty-docs volume (rag ingests automatically)
docker run --rm \
  -v browser_agent_rag-dirty-docs:/dst \
  -v /tmp/runbook_tagged:/src \
  alpine sh -c 'cp /src/*.html /dst/html/'

# Wait ~10 s for the ingester, then confirm
for i in 1 2 3 4 5 6 7 8 9 10; do
  count=$(curl -sS "http://localhost:6333/collections/${UUID}" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",{}).get("points_count","nx"))' 2>/dev/null)
  echo "probe $i: points_count=$count"
  [ "$count" = "3" ] && break
  sleep 2
done

rm -rf /tmp/runbook_tagged
```

Expected final probe: `points_count=3`. If you see `nx` after 10 probes, `docker compose logs -f rag` will show the ingestion pipeline working through the files — wait a bit longer.

The `SHARED_SKILLS_UUID` collection is intentionally left unpopulated for now; the agent's skills retrieval will return a clean HTTP 404 that `rag.ts` translates to an empty-hits envelope. That's the expected 1B state until Week 2 ingests real skill cards.

### 1.6.2 Kick the run

From another terminal (the agent Node server from §1.5.0 must still be running):

```bash
curl -sS -X POST http://localhost:3001/triage \
  -H 'content-type: application/json' \
  -d '{"ticketId":"T-demo","subject":"Reset password for jane@example.com"}' \
  | python3 -m json.tool
# -> { "runId": "<uuid>", "streamUrl": "/stream/<uuid>" }
```

Copy the `runId`, then open:

```
http://localhost:3000/agent/review/<runId>
```

### 1.6.3 What the reviewer UI should show

Expected end-to-end run: ~20–40 s depending on Anthropic latency. The reviewer page is a two-column grid (see `ARCHITECTURE.md §2.7` for the IA diagram): the LEFT column distills outcomes per step; the RIGHT column is a chronological behavior feed with step dividers, streaming LLM bubbles, pulsing tool-call cards, and inline 320×180 screenshot thumbnails. A draggable divider between the columns persists its ratio to `localStorage` under `reviewLeftPct`.

**Timeline flow (LEFT outcomes column + RIGHT behavior feed):**

1. **`classify`** (Haiku, thinking off) — LEFT shows `category · urgency · conf=X` on completion (~1–2 s). RIGHT shows `— CLASSIFY —` divider → `[haiku] streaming…` bubble with typewriter-revealed classification JSON → `✓ CLASSIFY · XXXms` divider.
2. **`retrieve`** — LEFT shows `3 runbook hits · 0 skill hits`. RIGHT shows two tool cards:
   - `→ rag.retrieveRunbooks` pulses (accent-blue breathing glow on the marker) then flips to `✓ rag.retrieveRunbooks · XXXms` with 3 nested hit rows (`0.76 runbooks/password-reset.html — An IT user has forgotten their password…` etc.).
   - `→ rag.retrieveSkills` completes with 0 hits (expected — the `SHARED_SKILLS_UUID` collection is intentionally empty in Week 1B; 404 → empty-envelope translation in `rag.ts`).
3. **`plan`** (Sonnet, thinking **on** at 8192 budget tokens) — completes in ~15–30 s. LEFT shows `N-step plan · ⚠ destructive` + the first 3 lines of `planText` with a gradient-fade `show full plan` toggle. RIGHT shows a `[sonnet] thinking…` bubble that streams the purple thinking block as deltas arrive, then the output text reveals char-by-char with a blinking `▊` caret (typewriter at ~60 cps with catchup). On `llm.message.completed`, the thinking block **collapses smoothly** (200 ms CSS grid transition) to a pill `[sonnet] thought for 12.4s · click to expand`; click the pill to re-expand, click the `collapse` link inside the expanded state to re-collapse.
4. **`dry_run`** (Commit 6b + 7a.iv) — LEFT shows `domMatches: ✓`. RIGHT is the densest step: `→ browser_navigate /login` → `→ browser_snapshot` → `→ browser_take_screenshot` (labelled `dry_run:login-page`, inline 320×180 thumb) → `→ browser_fill_form` → `→ browser_take_screenshot` (labelled `browser_fill_form:after`, 7a.iv post-action thumb) → `→ browser_click (sign-in)` → `→ browser_take_screenshot` (labelled `browser_click:after`) → continues through search → view-detail with a `:after` screenshot after every `click` / `fillForm`. Typical duration ~8–15 s. Click any thumbnail to open the full-size PNG in a new tab.
5. **`review_gate`** — Approve/Reject strip appears at the bottom of the page (natural flex flow, not sticky — the whole page is viewport-bounded). LEFT's `review_gate` row shows `awaiting reviewer`. Click **Approve** — or programmatically:
   ```bash
   curl -sS -X POST "http://localhost:3001/runs/<runId>/review" \
     -H 'content-type: application/json' \
     -d '{"decision":"approve","by":"operator","idempotencyKey":"'"$(uuidgen | tr A-Z a-z)"'"}'
   ```
6. **`execute`** (Commit 6b + 7a.iv) — LEFT shows `4 steps run` (the stepsRun counter is `executeStep`'s own logic; it's NOT inflated by 7a.iv's post-action screenshots, which add feed frames only). RIGHT: clicks the `Reset password` link → `:after` thumb → checks the `I confirm` checkbox → `:after` thumb → clicks the destructive `Reset password` button → `:after` thumb → snapshots the success page (labelled `execute:after-reset`, asserts `password reset successful` in the toast text). `session.close()` fires in `http/triage.ts` `finally` and cleans up the Chromium subprocess + per-run profile dir.
7. **`verify`** (real brief Sonnet call) + **`log_and_notify`** run. `run.completed { status: "ok" }`.

**Polish behaviors to verify on a fresh run (all landed in Commit 7a.v):**

- **Typewriter on plan's output text** — char-by-char reveal, not all-at-once; blinking `▊` caret at the tail of the revealed text while streaming.
- **Thinking bubble fade** — on `llm.message.completed`, the purple block smoothly collapses (200 ms) to a summary pill. Click to re-expand, click "collapse" to re-collapse.
- **Tool-card pulse** — pending `.feed-tool` markers breathe accent-blue; the pulse stops the instant `tool.completed` / `tool.failed` arrives.
- **Active-step autoscroll (LEFT)** — when a new step starts, its `.step-outcome` row scrolls into view via `block: "nearest"` (minimal motion). Gated by a 3 s idle rule: if the reviewer scrolled the outcomes column within the last 3 s, the auto-scroll is skipped.
- **Scroll anchor (RIGHT)** — during typewriter streaming and thinking-bubble collapse, the feed stays visually stable. The newest frame pins at ~1/3 from viewport top via `scrollIntoView({block: "start"}) + scroll-margin-top: 33vh`. Scroll up to read history → auto-scroll pauses for 3 s after the last manual scroll, then resumes.
- **Resizable divider** — drag the 8 px divider between the two columns; ratio clamped `[20, 80]`. Reload the page: ratio persists. Arrow-key focus on the divider then `←` / `→` shifts in 2 % steps.

Every frame also lands in Postgres `events` (the durable audit trail):

```bash
docker exec postgres psql -U agent -d agent -c \
  "SELECT seq, step_id, type FROM events WHERE run_id='<runId>' ORDER BY seq"
```

### 1.6.4 Sanity probes

- **Missing collection handling** — if you don't populate `SHARED_RUNBOOKS_UUID`, the run still finishes cleanly with `runbookHits: 0` on the retrieve step's output; no `tool.failed` frame, just an empty `rag.retrieved`.
- **rag down** — `docker stop rag`, kick a run: both retrievals hit the 90 s `AbortSignal` deadline and emit `tool.failed`. The workflow continues (soft-failure policy); `plan` still runs and the run eventually completes with `run.completed { status: "ok" }` unless reviewer rejects.
- **Reject path** — at the review gate, POST `"decision":"reject"`. `execute` / `verify` / `log_and_notify` all run with `skipped: true` and `run.completed { status: "rejected" }`. The `session.close()` finally-block still fires — `docker exec agent ps -ef | grep -iE 'chrom|playwright-mcp' | grep -v grep` should be empty within ~3 s of the reject.
- **Screenshots on disk** — after any `status=ok` run:
  ```bash
  docker exec agent bash -lc 'ls /workspace/.playwright-videos/<runId>/*.png | wc -l'
  # Expect: 12–15 PNGs (Commit 7a.iv bumped the count from 6 via implicit
  # post-action screenshots after every click/fillForm). Breakdown:
  # dry_run: 3 labelled + ~5 :after ≈ 8; execute: 3 labelled + ~4 :after ≈ 7.
  ```
  Plus the defensive check that none leaked into the agent package root (the 6b-hotfix-5 regression guard):
  ```bash
  docker exec agent bash -lc 'ls /workspace/services/agent/*.png 2>&1 | head'
  # Expect: "no matches found" / exit 2 — PNGs must be absolute-path'd into --output-dir.
  ```
- **Reviewer inline thumbnails (`<img>` rendering in behavior feed)** — open `http://localhost:3000/agent/review/<runId>` in a browser. The RIGHT behavior feed column renders one 320×180 thumbnail per `browser.screenshot` frame (labels: `dry_run:login-page`, `dry_run:users-list-initial`, `browser_fill_form:after`, `browser_click:after`, `execute:after-reset`, etc.). Click any thumbnail to open the full-size PNG in a new tab. DevTools Network tab → filter `/api/static/` → each thumbnail is a single `200 OK image/png` with `Cache-Control: private, max-age=3600` preserved from the agent's `/static` response through the Next.js rewrite. No CORS errors.
- **Back-to-back runs without session bleed (Commit 6c-1)** — kick two runs in a row without restarting the test-webapp. Both should emit a real `/login` snapshot in their `dry_run` step (quoted `textbox "Email" [ref=e…]` in the accessibility tree) — not a redirect to the previous run's user detail page. The per-run `.mcp-profile` dir at `/workspace/.playwright-videos/<runId>/.mcp-profile/` is created during the run and wiped on `session.close()`.

### 1.6.5 Pre-exec Edit-refine path (7b.iii.b commit 4)

The reviewer can guide the agent from the **pre-exec** review gate by clicking **Edit** (instead of Approve / Reject / Terminate) and typing a note. Week-2a gate-decision-model: Edit threads reviewer's notes as seed observations; Reject threads an auto-generated directive seed observation ("take a different approach") into the SAME refine loop; Terminate skip-cascades to `status=rejected` (see §1.6.5.1 below). Edit and Reject share `MAX_PRE_GATE_REFINES = 2` budget (3 total review cycles across any mix of Edit/Reject; 3rd refine trip returns `decision: "terminate"` from the cap-trip path).

**UI walkthrough:**

1. Kick a run (§1.6.2). Wait for the review gate.
2. In the review panel (bottom of `/agent/review/<runId>`), click **Edit** (leftmost of the three accent-blue / red / green buttons).
3. Panel swaps to edit-mode: heading "Guide the agent · re-plan" + textarea (autofocus, 2000-char counter). Submit button is disabled until the textarea has non-empty trimmed text.
4. Type a guidance note, e.g. `"target user is jane@example.com; use the Unlock Account runbook, not Password Reset"`.
5. Click **Submit & re-plan**. Panel swaps to submitting-mode: accent-border, "Re-planning…" heading, disabled "Waiting for refined plan…" button, and a secondary "Cancel refine (unlock panel)" button.
6. Watch the RIGHT behavior feed:
   - `review.decided { decision: "edit", patch: { notes: "..." } }` fires (a compact tool-card-style row).
   - `FeedBacktrackBanner` renders as a full-width accent-blue "BACKTRACK #1 · review_gate → block1" banner with the reviewer's note highlighted.
   - Block 1 re-runs visibly (a fresh `— BLOCK 1 · PASS 0 —` divider, then classify/retrieve/plan/dry_run frames again). LEFT column rows update as their new `step.completed` frames land (the `findLast` read path picks up the refined values).
   - A new `review.requested` lands. Panel auto-exits submitting-mode → default-mode with Edit / Reject / Approve buttons rendering the refined plan.
7. Click **Approve** on the refined plan. Run completes → `status=ok`, Jane's DB row actually mutates (§1.6.6 acceptance check).

**Alternate: Cancel refine escape hatch.** In submitting-mode, click "Cancel refine (unlock panel)" before the fresh `review.requested` arrives. Panel returns to default-mode on the STALE request. The server-side Block 1 refine continues running (uninterruptible in this release); when the fresh `review.requested` arrives, `pendingReview` memo picks it up and the panel auto-renders the refined plan. Any Approve/Reject clicked on the stale panel between Cancel-refine and fresh-request-arrival hits the bus's stale-discard path (logged + dropped per commit 1 semantics); reviewer must re-click once the fresh request appears.

**Curl equivalent (for CI / non-UI smoke):**

```bash
curl -sS -X POST "http://localhost:3001/runs/<runId>/review" \
  -H 'content-type: application/json' \
  -d '{"decision":"edit","by":"operator","patch":{"notes":"use the Unlock Account runbook"},"idempotencyKey":"'"$(uuidgen | tr A-Z a-z)"'"}'
```

### 1.6.5.1 Pre-exec Terminate path (Week-2a gate-decision-model)

The reviewer can full-stop the run at the pre-exec review gate by clicking the **Terminate** text-link beneath the three primary buttons. Distinct from Reject (which replans) — Terminate is the explicit kill. Two-step confirmation prevents accidental clicks.

**UI walkthrough:**

1. Kick a run (§1.6.2). Wait for the review gate.
2. In the ChatBar, click the **Terminate** text-link. The link arms: label changes to `─ Really terminate? (click again within 3s to confirm) ─` and `.armed` className applies.
3. Click **Terminate** again within 3 seconds. Panel transitions to `submitting`-then-`terminal` mode; all controls disable.
4. Watch the RIGHT behavior feed:
   - `review.decided { decision: "terminate" }` fires.
   - Skip-cascade begins: `executeStep` returns `{ stepsRun: 0, skipped: true }`; `verifyStep` returns `{ success: false, skipped: true, evidence: [] }`; **`humanVerifyGateStep`'s entry skip-guard fires** — `inputData.skipped === true` → returns immediately without opening the post-exec gate. No `review.requested{post_exec}` emits.
   - `logAndNotifyStep` runs; `run.completed { status: "rejected" }` fires.
5. Verify DB cross-check: Jane's row is NOT mutated — `status` remains whatever it was pre-run; `last_password_reset_at` is NOT updated.

**Expected run latency post-terminate: ~2 seconds** (skip-cascade has no LLM calls, no Playwright work — just state threading through the remaining steps).

**Curl equivalent:**

```bash
curl -sS -X POST "http://localhost:3001/runs/<runId>/review" \
  -H 'content-type: application/json' \
  -d '{"decision":"terminate","by":"operator","idempotencyKey":"'"$(uuidgen | tr A-Z a-z)"'"}'
```

Post-exec Terminate is symmetric — same curl with `"stepId":"human_verify_gate"` and same skip-cascade-to-rejected outcome.

**Smoke acceptance (P4 path):**

- `run.completed.status === 'rejected'`
- ZERO `review.requested` frames where `payload.reviewHint === 'post_exec'`
- `reviews.decision === 'terminate'` in Postgres
- 4 forensic fingerprints all 0 (§1.6.7 SQL queries unchanged)
- Jane unchanged (pre-run state preserved)

### 1.6.6 Post-exec gate path + backtrack (7b.iii.b commit 4)

After `executeStep` + `verifyStep` complete, the workflow suspends on a second human gate: `humanVerifyGateStep` with `reviewHint: "post_exec"`. The reviewer can approve (run completes) or reject (backtrack triggers a full re-run of block1 → reviewGate → execute → verify with `buildBacktrackContext` observations carried forward). Cap: `MAX_BACKTRACKS = 2` (3 total post-exec cycles; 3rd reject forces `verify.success: false` + evidence marker; run terminates `status=failed`).

**UI walkthrough:**

1. After approving pre-exec (§1.6.3 step 5 or §1.6.5), executeStep runs (drives the destructive reset), verifyStep runs. Shortly after verify completes, a SECOND `review.requested` frame lands with `reviewHint: "post_exec"`.
2. Panel renders the **post-exec variant**:
   - Heading: "Post-execution review".
   - Body: references `execute:*` screenshots in the behavior feed + verify output + "max 2 retries" copy.
   - Buttons: **Reject (backtrack)** / **Approve (complete)**. **No Edit button** (deliberately hidden — `humanVerifyGateStep` treats edit as approve-equivalent, so an Edit button would wedge the submitting-mode state machine; see ReviewPanel component docblock).
3. **Happy path — Approve:** click Approve. Run completes with `status=ok`. Jane's row remains reset from the approved executeStep (DB cross-check per §1.6.6 acceptance).
4. **Backtrack path — Reject:** click Reject. Behavior feed shows:
   - `review.decided { decision: "reject" }`.
   - `FeedBacktrackBanner` as a full-width warn-yellow "BACKTRACK #1 · human_verify_gate → block1" banner; reviewer note (if the Reject carried patch.notes) highlighted; prior-attempt summary ("Carrying 3 observations forward").
   - Fresh `block1 → reviewGate → execute → verify` chain re-runs visibly.
   - Second post-exec review.requested lands when verify completes.
   - Reviewer can approve / reject-again / reject-one-more-time-to-exhaust-budget.
5. **Budget exhaust:** after 3 sequential rejects on post-exec, `humanVerifyGateStep` terminates with `verify.success: false` + evidence entry `"Backtrack budget exhausted after 2 iterations; final human-verify decision: reject."`. `logger.warn { backtrackCount: 2, max: 2 }` fires. Run terminates with `status=failed`.

**Curl equivalent for post-exec decision:**

```bash
curl -sS -X POST "http://localhost:3001/runs/<runId>/review" \
  -H 'content-type: application/json' \
  -d '{"decision":"reject","by":"operator","stepId":"human_verify_gate","idempotencyKey":"'"$(uuidgen | tr A-Z a-z)"'"}'
```

Note the `"stepId":"human_verify_gate"` field — required to route the decision to the correct per-stepId bus slot (commit 1's `GateStepIdSchema`). Without it, the server defaults to `"review_gate"` and the decision lands on the wrong gate's slot.

### 1.6.7 Forensic acceptance guards (mandatory for any smoke report)

Any run reported as `status=ok` via the wire MUST pass the following SQL cross-checks before it's considered clean. This discipline was ratified during the 7b.iii.b series after Bug A's initial smoke false-positived on wire status alone (Sonnet's `verifyStep` prompt can hallucinate `/verified/i` against `stepsRun=0` input — meta-observation in MASTER_PLAN). **DB cross-check is authoritative, NOT the wire.**

```bash
# (1) DB cross-check: Jane's row actually mutated on approve paths.
# Query test-webapp's seed/session-cookie store by reloading /users/<jane-id>
# in a browser or via curl with the admin cookie. Expect: status=active +
# fresh lastPasswordReset timestamp within the last few minutes. pre-Bug-A
# runs reported status=ok with Jane still locked.

# (2) Bug A fingerprint (spread-mutation loss on ctx.browser).
docker compose exec -T postgres psql -U agent -d agent -c "
SELECT run_id, COUNT(*) AS count
FROM events
WHERE run_id IN ('<new-run-ids>')
  AND type='tool.failed'
  AND payload->>'name'='playwright.session_check'
  AND payload->'error'->>'message' LIKE '%no browser session%'
GROUP BY run_id;
"
# Expect: 0 rows.

# (3) Bug B fingerprint (browser-lock collision).
docker compose exec -T postgres psql -U agent -d agent -c "
SELECT run_id, COUNT(*) FROM events
WHERE run_id IN ('<new-run-ids>')
  AND type='tool.failed'
  AND payload->'error'->>'message' LIKE '%Browser is already in use%'
GROUP BY run_id;
"
# Expect: 0 rows.

# (4) Bug 4 fingerprint (session closed between refine's dry_run and executeStep).
docker compose exec -T postgres psql -U agent -d agent -c "
SELECT run_id, COUNT(*) FROM events
WHERE run_id IN ('<new-run-ids>')
  AND type='tool.failed'
  AND payload->'error'->>'message' LIKE '%session already closed%'
GROUP BY run_id;
"
# Expect: 0 rows.

# (5) Bug 3A fingerprint (envelope overflow on oversize step.completed).
docker compose exec -T postgres psql -U agent -d agent -c "
SELECT run_id, COUNT(*) FROM events
WHERE run_id IN ('<new-run-ids>')
  AND type='run.failed'
  AND payload->'error'->>'message' = 'envelope_violation'
GROUP BY run_id;
"
# Expect: 0 rows post-commit-4 (the thinking drop in runPlanStep mitigates).

# (6) LEFT-column truth-invariant — on any refine or backtrack run, verify
# that block1's synthetic step.completed frames emitted with distinct planIds.
docker compose exec -T postgres psql -U agent -d agent -c "
SELECT seq,
       payload->'output'->'plan'->>'planId' AS plan_id,
       payload->'output'->'plan'->>'actionCount' AS actions
FROM events
WHERE run_id='<refine-or-backtrack-run-id>'
  AND type='step.completed' AND step_id='block1'
ORDER BY seq;
"
# Expect: ≥ 2 rows on refine/backtrack runs, with DISTINCT planIds (initial
# from Mastra's stepEmitter + synthetic from 7b.iii.b commit 4 Piece B).
# 1 row only on straight approve-pre-exec + approve-post-exec runs.
```

See `docs/MASTER_PLAN.md` for the full forensic fingerprint table + causal narrative ("Bug A hid Bug B hid Bug 4; Bug 3A orthogonal").

### 1.6.7.1 Budget-exhaust + Terminate clarification (post-Commit-A / Commit-B)

Budget exhaust and explicit Terminate both map to `run.completed.status === 'rejected'` via the skipped-derivation path at `triage.ts:1638-1642`. Pre-week2a, post-exec budget exhaust produced `status: 'failed'` — that was wrong (workflow-layer fault, not reviewer-initiated rejection). Commit A (Finding 2) fixed the exhaust path to set `skipped: true`; Commit B added Terminate which uses the same mechanism. Sanity check on any terminated-or-exhausted run:

```bash
docker compose exec -T postgres psql -U agent -d agent -c "
SELECT id, status
FROM runs
WHERE id = '<run-id>';
"
# Expect: status='rejected' for terminate / exhaust paths.
# status='failed' should ONLY appear on runs where a step body threw an
# unhandled exception (genuine workflow faults) — NOT on budget exhaust
# or explicit terminate decisions.
```

The 4 forensic SQL fingerprints from §1.6.7 remain unchanged by Week-2a — no new failure modes introduced. Run them on every new `run_id` as before.

### 1.6.8 ChatBar testids (Week-2a reviewer UI reference)

Data-testids live on every interactive ChatBar control so Playwright and browser-MCP drivers can automate the reviewer surface. Stable across all four ChatBar modes (`idle` / `decision-required` / `submitting` / `terminal`).

| Element | Testid | Notes |
|---|---|---|
| ChatBar textarea | `chat-bar-textarea` | Enabled in `idle` + `decision-required` modes; becomes `patch.notes` payload on Edit submit |
| Approve button | `chat-bar-approve` | Disabled on exhausted blocks (`blockResult.passedLast === false`) |
| Reject button | `chat-bar-reject` | Always enabled in `decision-required` mode; routes to refine loop (pre-exec) or backtrack (post-exec) |
| Edit button | `chat-bar-edit` | Enabled only when textarea has non-empty trimmed content (`canSubmitEdit`). HIDDEN in `idle` AND on post-exec (`reviewHint === "post_exec"`). Cmd+Enter keyboard shortcut also fires Edit. |
| Terminate link | `chat-bar-terminate` | Always available when `canTerminate === true`. Two-step confirm: first click arms (`.armed` className), second click within `TERMINATE_CONFIRM_MS = 3000` commits `decision: "terminate"`. |
| Exhausted banner | `chat-bar-exhausted-banner` | Rendered when `blockResult.passedLast === false` |
| Decision-mode pulse | `.chat-bar.decision-required` | CSS `animation: toolPulse 1.8s ease-out infinite` — verify visually (respects `prefers-reduced-motion`) |

---

## 2. Local — inspect & work with the stack

### Status & health

```bash
docker compose ps                                                      # one-line-per-service
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

# Health status only
for s in qdrant postgres rag services-healthcheck; do
  printf '%-22s %s\n' "$s" "$(docker inspect "$s" --format '{{.State.Health.Status}}' 2>/dev/null)"
done

# Per-service healthcheck probe history (last N runs w/ exit codes and output)
docker inspect rag --format '{{json .State.Health}}' | python3 -m json.tool | tail -40
```

### Logs

```bash
# Follow everything live
docker compose logs -f

# Follow a single service
docker compose logs -f rag
docker compose logs -f --tail=100 agent

# Dump last N lines of one container
docker logs --tail 200 rag

# Since a timestamp
docker logs --since 10m qdrant
```

### Exec into a container

```bash
# The dev container (main working environment)
docker exec -it agent bash

# RAG service (Python 3.11 slim, has python + bash)
docker exec -it rag bash

# Qdrant (minimal image, only bash available)
docker exec -it qdrant bash

# Postgres
docker exec -it postgres bash
# …or straight into psql
docker exec -it postgres psql -U agent -d agent

# Browser-viewer
docker exec -it browser-viewer bash
```

### Functional probes (copy-paste)

```bash
# Qdrant
curl -s http://localhost:6333/readyz    && echo
curl -s http://localhost:6333/collections | python3 -m json.tool

# Postgres
docker exec postgres pg_isready -U agent -d agent
docker exec postgres psql -U agent -d agent -c '\l'

# RAG service
curl -s http://localhost:3009/monitor | python3 -m json.tool

# RAG — issue a QA search (only after at least one doc is embedded)
curl -s -X POST http://localhost:3009/docs/models/qa \
  -H 'content-type: application/json' \
  -d '{"query":"how do I reset a password","collection_name":"document_vectors"}' \
  | python3 -m json.tool

# Browser-viewer (noVNC UI)
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:6080/vnc.html
open http://localhost:6080                 # macOS — opens in default browser

# Agent (Week 1 onward)
curl -s http://localhost:3001/healthz || echo '(not running yet — Week 1)'
```

### Ingesting a document into RAG (smoke test)

```bash
# Drop a markdown runbook into the watch directory
echo '# Password reset runbook\n\nTo reset a user password in the admin portal, search for the user, open their record, click Reset Password, confirm the action.' > /tmp/runbook.md

# Copy into the named volume by mounting it into a helper container
docker run --rm -v browser_agent_rag-dirty-docs:/dst -v /tmp:/src alpine \
  sh -c 'mkdir -p /dst/md && cp /src/runbook.md /dst/md/'

# Watch rag ingest it
docker compose logs -f --tail=50 rag
# Expect lines like:
#   INFO:src.util.queue: ... processing file: ... runbook.md
#   INFO:src.vector_store.qdrant_config:[QdrantManager] Done upserting ...
```

---

## 3. Local — stop & tear down

```bash
# Pause everything (containers remain, volumes remain)
docker compose stop

# Resume after stop
docker compose start

# Remove containers + network (volumes KEPT — this is the normal "shut down" command)
docker compose down

# Remove containers + network + volumes (DESTRUCTIVE — wipes qdrant data, pg data, HF cache)
docker compose down -v

# Nuke built images too (full reset)
docker compose down -v --rmi local
```

Single-service variants:

```bash
docker compose stop agent                      # pause one service
docker compose rm -f agent                     # remove its container
docker compose restart rag                     # stop + start a single service
```

---

## 4. Publish images — Docker Hub (`gbeals1`)

Your existing naming convention is `gbeals1/<repo>:<component>-v<version>`. We'll publish all three services under a single repo (`browser-agent`) with component-prefixed tags. Matches the pattern from your `api-servers` repo.

### 4.1 One-time

```bash
docker login                                   # username: gbeals1
```

### 4.2 Set the version you're releasing

```bash
export VERSION=0.1.0
export DH_REPO=gbeals1/browser-agent
```

### 4.3 Build multi-arch (IMPORTANT — see §6)

Your laptop is `linux/arm64`. Azure Container Apps and AKS default node pools are `linux/amd64`. If you only push arm64, cloud deploys will fail to start. Use `buildx` to publish both, so your image runs anywhere.

```bash
# One-time: ensure buildx is available and set up a builder
docker buildx create --name agentbuilder --use --bootstrap 2>/dev/null || docker buildx use agentbuilder

# Build + push each service as multi-arch in a single pass
# (buildx --push writes directly to the registry; there's no local image)

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${DH_REPO}:agent-v${VERSION}" \
  -t "${DH_REPO}:agent-latest" \
  -f services/agent/Dockerfile \
  services/agent \
  --push

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${DH_REPO}:rag-v${VERSION}" \
  -t "${DH_REPO}:rag-latest" \
  -f services/rag/dockerfile \
  services/rag \
  --push

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${DH_REPO}:browser-viewer-v${VERSION}" \
  -t "${DH_REPO}:browser-viewer-latest" \
  -f services/browser-viewer/dockerfile \
  services/browser-viewer \
  --push
```

### 4.4 Verify on Docker Hub

```bash
# List remote tags (requires curl; Docker Hub public API)
curl -s "https://hub.docker.com/v2/repositories/${DH_REPO}/tags?page_size=50" \
  | python3 -c 'import sys,json; [print(t["name"]) for t in json.load(sys.stdin)["results"]]'
```

Browse: `https://hub.docker.com/r/gbeals1/browser-agent/tags`

### 4.5 One-liner to push a new version later

```bash
export VERSION=0.2.0 DH_REPO=gbeals1/browser-agent
for svc in agent rag browser-viewer; do
  case $svc in
    agent)          DF=services/agent/Dockerfile           CTX=services/agent ;;
    rag)            DF=services/rag/dockerfile             CTX=services/rag ;;
    browser-viewer) DF=services/browser-viewer/dockerfile  CTX=services/browser-viewer ;;
  esac
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t "${DH_REPO}:${svc}-v${VERSION}" -t "${DH_REPO}:${svc}-latest" \
    -f "$DF" "$CTX" --push
done
```

---

## 5. Publish images — Azure Container Registry (for ACA / AKS)

Azure Container Apps and AKS read from any OCI-compliant registry, but **Azure Container Registry (ACR)** is the first-class path: it's integrated with managed identities, has geo-replication, and AKS admission is one command (`az aks update --attach-acr`). This section stands up ACR and pushes the same three images there.

### 5.1 One-time — create infra

```bash
# Set variables for your deployment
export AZ_SUB="your-subscription-id-or-name"
export AZ_RG="browser-agent-rg"
export AZ_LOC="eastus"
export ACR_NAME="browseragentacr"                     # must be globally unique, alnum only, 5–50 chars
export ACR_SKU="Basic"                                # Basic is fine for v1; upgrade later

az login
az account set --subscription "$AZ_SUB"
az group create --name "$AZ_RG" --location "$AZ_LOC"
az acr create --resource-group "$AZ_RG" --name "$ACR_NAME" --sku "$ACR_SKU"
```

### 5.2 Authenticate Docker to ACR

```bash
# Picks up the current az login and forwards credentials to docker
az acr login --name "$ACR_NAME"
```

### 5.3 Push

```bash
export ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
export ACR_REPO="${ACR_LOGIN_SERVER}/browser-agent"
export VERSION=0.1.0

for svc in agent rag browser-viewer; do
  case $svc in
    agent)          DF=services/agent/Dockerfile           CTX=services/agent ;;
    rag)            DF=services/rag/dockerfile             CTX=services/rag ;;
    browser-viewer) DF=services/browser-viewer/dockerfile  CTX=services/browser-viewer ;;
  esac
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t "${ACR_REPO}:${svc}-v${VERSION}" -t "${ACR_REPO}:${svc}-latest" \
    -f "$DF" "$CTX" --push
done
```

### 5.4 Verify

```bash
az acr repository list --name "$ACR_NAME" -o tsv
az acr repository show-tags --name "$ACR_NAME" --repository browser-agent -o tsv
```

### 5.5 Attach ACR to AKS (so the cluster can pull without image-pull-secrets)

```bash
# If you already have an AKS cluster
az aks update --name <your-aks> --resource-group "$AZ_RG" --attach-acr "$ACR_NAME"
```

### 5.6 Example deploy — Azure Container Apps (one service at a time)

ACA is the fastest way to run these images in Azure without touching Kubernetes. Create a Container Apps environment, then create one app per service.

```bash
# Container Apps environment (one per region, reused across services)
export ACA_ENV="browser-agent-env"
az containerapp env create --name "$ACA_ENV" --resource-group "$AZ_RG" --location "$AZ_LOC"

# rag (internal; no public ingress — only agent reaches it)
az containerapp create \
  --name rag \
  --resource-group "$AZ_RG" \
  --environment "$ACA_ENV" \
  --image "${ACR_REPO}:rag-v${VERSION}" \
  --target-port 3009 \
  --ingress internal \
  --registry-server "$ACR_LOGIN_SERVER" \
  --cpu 2 --memory 4Gi \
  --min-replicas 1 --max-replicas 1

# agent (public; ingress on 3001)
az containerapp create \
  --name agent \
  --resource-group "$AZ_RG" \
  --environment "$ACA_ENV" \
  --image "${ACR_REPO}:agent-v${VERSION}" \
  --target-port 3001 \
  --ingress external \
  --registry-server "$ACR_LOGIN_SERVER" \
  --env-vars RAG_URL=https://rag.internal:3009 QDRANT_URL=... PG_URL=... \
  --cpu 1 --memory 2Gi
```

Qdrant + Postgres for production: run them as ACA apps too (persistent storage via Azure Files or Managed Disks) **or** use Azure-managed equivalents (`Azure Database for PostgreSQL`, and either self-host Qdrant or switch to Azure AI Search / Cosmos DB for vector workloads). That decision is Phase 5+.

### 5.7 Example deploy — AKS (Kubernetes manifest sketch)

Once ACR is attached to the cluster, a minimal deployment reference:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent
spec:
  replicas: 1
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec:
      containers:
      - name: agent
        image: browseragentacr.azurecr.io/browser-agent:agent-v0.1.0
        ports: [{ containerPort: 3001 }]
        env:
          - { name: RAG_URL,    value: http://rag:3009    }
          - { name: QDRANT_URL, value: http://qdrant:6333 }
          - { name: PG_URL, valueFrom: { secretKeyRef: { name: agent-db, key: dsn } } }
---
apiVersion: v1
kind: Service
metadata: { name: agent }
spec:
  selector: { app: agent }
  ports: [{ port: 80, targetPort: 3001 }]
  type: LoadBalancer
```

(Apply the same pattern for `rag`, `qdrant`, `postgres`, `browser-viewer`.)

---

## 6. Multi-arch gotcha (read me)

Your Mac is `linux/arm64`. Cloud compute is usually `linux/amd64`:

| Target | Arch |
|---|---|
| Your Mac | `linux/arm64` |
| Azure Container Apps default | `linux/amd64` |
| AKS default node pool | `linux/amd64` |
| AWS Graviton / Azure Ampere (optional) | `linux/arm64` |

Rules:

- `docker compose build` builds for whatever your machine is (arm64 on your Mac). **Fine for local.**
- `docker buildx build --platform linux/amd64,linux/arm64 --push` publishes a manifest list that satisfies both. **Required for cloud.**
- If you shortcut with `docker build + docker push` on arm64 and deploy to ACA/AKS, the pods will fail with `exec format error`. Always use `buildx --push` for publishing.

### Gotcha: every service in `docker-compose.yml` is pinned to `linux/arm64`

Every service block in `docker-compose.yml` has `platform: linux/arm64` set — including third-party images (`postgres:16`, `qdrant/qdrant:latest`, `busybox`). This matches your Apple-silicon Mac and is correct for local dev.

What to watch for:

- On an **amd64 host** (Linux server, GitHub Actions runner, a colleague's Intel laptop) Docker will still pull the arm64 manifest of those images and run them under **QEMU emulation**. Everything works, but Postgres and Qdrant will crawl. Symptom: healthchecks pass but everything feels 5–10× slower.
- Fix when you need it: either remove the platform pins from the compose file for a portable checkout, or drive the pin from an env var (e.g. `platform: ${DOCKER_PLATFORM:-linux/arm64}`) and set `DOCKER_PLATFORM=linux/amd64` in your CI.
- The `--platform linux/amd64,linux/arm64` multi-arch push in §4 / §5 is unaffected — those commands explicitly override the compose pin.

---

## 7. Secrets — what *not* to bake into images

Never push images containing:

- `.env` (already `.dockerignore`-listed)
- Target-app credentials
- LLM API keys
- Postgres passwords

Inject them at runtime via:

- `docker compose` → `.env` (gitignored)
- ACA → `--env-vars` / `az containerapp secret set`
- AKS → `Secret` + `envFrom.secretRef` / external secrets operator

The `.dockerignore` in this repo excludes `.env`, `node_modules/`, `__pycache__/`, `dist/`, `.venv/`, tests, docs, and VCS metadata from the build context.

---

## 8. Tag hygiene

Version scheme: semver per-service (`agent-v0.1.0`, `rag-v0.1.0`, etc.). `-latest` is a convenience alias; do not deploy it to production.

| Tag | Use |
|---|---|
| `<svc>-v0.1.0` | Pinned release. Use in production manifests. |
| `<svc>-latest` | Always the newest published release. Fine for `docker compose pull` in dev. |
| `<svc>-sha-abc1234` | (Future) CI-generated immutable tag per commit. Add when CI lands. |

---

## 9. Quick reference card

```bash
# UP
docker compose up -d --wait

# STATUS
docker compose ps

# LOGS
docker compose logs -f rag

# EXEC
docker exec -it agent bash

# DOWN (keep volumes)
docker compose down

# DOWN (wipe volumes — destructive)
docker compose down -v

# PUBLISH (multi-arch, to Docker Hub + ACR)
export VERSION=0.1.0 DH_REPO=gbeals1/browser-agent ACR_REPO="${ACR_NAME}.azurecr.io/browser-agent"
for svc in agent rag browser-viewer; do
  [ "$svc" = agent ]          && DF=services/agent/Dockerfile          && CTX=services/agent
  [ "$svc" = rag ]            && DF=services/rag/dockerfile            && CTX=services/rag
  [ "$svc" = browser-viewer ] && DF=services/browser-viewer/dockerfile && CTX=services/browser-viewer
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t "${DH_REPO}:${svc}-v${VERSION}"  -t "${DH_REPO}:${svc}-latest" \
    -t "${ACR_REPO}:${svc}-v${VERSION}" -t "${ACR_REPO}:${svc}-latest" \
    -f "$DF" "$CTX" --push
done
```
