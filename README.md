# browser_agent

A **platform-pivotable substrate for human-in-the-loop agents**, populated as a tier-1 IT helpdesk triage tool that controls a real browser through human review gates. Every run is auditable, every destructive action is gated, and the whole substrate is designed to pivot to adjacent verticals (agentic code editor, LLM training data collection, generic HITL editor) with minimal rework.

> 🎥 **Demo video coming soon** — a walkthrough of a live run (ticket → plan → human review → browser execution → verify → approve) will be embedded here.

---

## Why this project is interesting

Most agent frameworks optimize for autonomy. This one is built around the opposite bet: **human-gated destructive action is the product**. The engineering trade-offs follow from there.

- **Two-gate HIL workflow with a 4-decision model.** Reviewers see the agent's proposed plan before any destructive action runs, and the post-execution result before the run is closed. At each gate, the reviewer can `approve`, `reject` (replan without notes), `edit` (replan with notes), or `terminate` (full-stop). All four decisions are wired end-to-end through Zod-validated envelope frames, a per-stepId decision bus, and a Postgres audit log.
- **Platform-pivot architecture.** The orchestration engine, event bus, circuit breaker, and reviewer UI are vertical-agnostic substrate. The IT-helpdesk specifics (Playwright MCP, runbooks, skill cards) live in a swappable tool layer. A `**[PLATFORM_PIVOT_POINT` git tag](https://github.com/guyycodes/Reactive_Browser_Agent/releases/tag/PLATFORM_PIVOT_POINT)** freezes the substrate baseline; `git checkout PLATFORM_PIVOT_POINT` returns to a revert point for any future pivot. See `[docs/PLATFORM_PIVOTS.md](./docs/PLATFORM_PIVOTS.md)` for the layer-swap map across four candidate verticals.
- **Frames are the single source of truth.** Every agent-internal event (LLM thinking deltas, tool calls, browser screenshots, human decisions) emits a Zod-validated envelope frame with a monotonic sequence number. The reviewer UI, the Postgres audit log, and any future replay/eval harness all read the same frame stream. No side channels, no observability debt.
- **Streaming ReAct reasoning.** Cognitive steps (`classify`, `retrieve`, `plan`, `verify`) use a reusable `createReActStep` runner that emits nested `react.iteration.`* frames, letting the reviewer watch the agent think → call a tool → observe → refine in real time.
- **Circuit-breaker hardened LLM calls.** Every Anthropic streaming call routes through a three-state breaker (closed → open → half-open) with exponential backoff and single-probe recovery. Transient 5xx storms no longer kill runs.
- **Retroactive forensic audit trail.** Four documented bug fingerprints can be queried against the append-only Postgres `events` table at any time. Each bug's SQL signature, affected runs, and causal narrative lives in `[docs/MASTER_PLAN.md](./docs/MASTER_PLAN.md)`.

---

## Current status

**Week 2a complete — 157/157 tests green, PLATFORM_PIVOT_POINT tagged.**

- ✅ Phase 0 — Docker Compose infrastructure + RAG embedding pipeline (self-patched HF model, per-document Qdrant collections via UUID filename convention)
- ✅ Week 1A — Envelope schema + EventBus + Anthropic streamMapper + reviewer UI scaffold
- ✅ Week 1B — Real browser control (Playwright MCP) + real RAG retrieval + ReAct runner + Block 1 controller + pre-exec review gate + post-exec verify gate + refine-loop and backtrack-loop meta-loops
- ✅ **Week 2a — ChatBar reviewer UI refactor + 4-decision HIL model + substrate pivot-point tagged**
- ⏳ Week 2b — skill-card schema + RAG wiring to replace hardcoded IT flows
- ⏳ Week 2c — apply `createReActStep` to `classify` and `verify`

See `[docs/MASTER_PLAN.md](./docs/MASTER_PLAN.md)` for the full progress table, forensic bug audit, and Week-2 polish queue.

---

## Architecture at a glance

```
┌─────────────── docker compose (agent-net 172.28.0.0/16) ──────────────┐
│                                                                       │
│  agent          Mastra workflows + Playwright MCP + HTTP/WS           │
│                 ├─ POST /triage          start a run                  │
│                 ├─ WS   /stream/:runId   live envelope frames         │
│                 └─ POST /runs/:id/review reviewer decision → bus      │
│                                                                       │
│  test-webapp    Next.js 14 — reviewer UI at /agent/review/[runId]     │
│                 Also serves as the Playwright target (login/users/…)  │
│                                                                       │
│  rag            FastAPI + Qdrant — e5-large-v2 embeddings             │
│  qdrant         Vector DB, UUID-named collections, append semantics   │
│  postgres       events + reviews + runs tables (append-only audit)    │
│  browser-viewer noVNC bridge (compose-wired but idle; screenshot      │
│                 rail in the reviewer UI delivers ~95% of its value)   │
└───────────────────────────────────────────────────────────────────────┘
```

For the full architectural documentation:


| Doc                                                    | Purpose                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)`       | Repo-level topology, service contracts, reviewer UI information architecture                     |
| `[docs/Architecture.txt](./docs/Architecture.txt)`     | Agent-code visual (layer cake + workflow + ReAct + meta-loops), beginner-friendly                |
| `[docs/MASTER_PLAN.md](./docs/MASTER_PLAN.md)`         | Roadmap, commit-by-commit progress, forensic audit trail, polish queue                           |
| `[docs/PLATFORM_PIVOTS.md](./docs/PLATFORM_PIVOTS.md)` | Layer-swap map for pivoting to other verticals (training tool, coding tool, generic HITL editor) |
| `[docs/STARTUP_PROCESS.md](./docs/STARTUP_PROCESS.md)` | Boot + smoke + forensic acceptance guards                                                        |


---

## Services (on `agent-net`)


| Service          | Role                                        | Host port(s)   | Internal DNS     |
| ---------------- | ------------------------------------------- | -------------- | ---------------- |
| `agent`          | Mastra workflows + Playwright MCP + HTTP/WS | `3001`, `9229` | `agent`          |
| `test-webapp`    | Reviewer UI + Playwright target             | `3000`         | `test-webapp`    |
| `rag`            | FastAPI embedder (e5-large-v2, 1024-dim)    | `3009`         | `rag`            |
| `qdrant`         | Vector DB                                   | `6333`, `6334` | `qdrant`         |
| `postgres`       | Events + reviews + runs                     | `5432`         | `postgres`       |
| `browser-viewer` | noVNC bridge (parked)                       | `6080`         | `browser-viewer` |


A `services-healthcheck` aggregator gates on `qdrant + postgres + rag` so tooling / CI has a single readiness signal.

---

### Pivot point tag

The `PLATFORM_PIVOT_POINT` tag is a snapshot of the IT-helpdesk substrate baseline. It's the commit that contains the IT-tool tool-layer and chain-bodies populated as the canonical reference implementation.

## env variables

```bash
# Local overrides — gitignored. Mirror `.env.example` structure; keep values real.

# --- LLM provider (used by the agent service — Claude Haiku/Sonnet/Opus) ---
ANTHROPIC_API_KEY='sk-ant-...'

# Pinned model identifiers.
ANTHROPIC_MODEL_HAIKU=claude-haiku-4-5
ANTHROPIC_MODEL_SONNET=claude-sonnet-4-5
ANTHROPIC_MODEL_OPUS=claude-opus-4-5

# Reserved for alternate providers; unused by the agent service today.
OPENAI_API_KEY=

# --- Postgres (matches docker-compose defaults; override if you change them) ---
POSTGRES_USER=agent
POSTGRES_PASSWORD=agent
POSTGRES_DB=agent

# --- Shared Qdrant collection UUIDs (per MASTER_PLAN §3) ---
SHARED_RUNBOOKS_UUID=
SHARED_SKILLS_UUID=
SHARED_SELECTORS_UUID=

# --- WebSocket origin allowlist for /stream/:runId ---
ALLOWED_WS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:6080,http://127.0.0.1:6080,http://localhost:3001,http://127.0.0.1:3001

# --- Target-app credentials (Week 1B — read by Playwright only, never surfaced to the LLM) ---
TARGET_APP_USER=
TARGET_APP_PASSWORD=

# --- Hugging Face (used by services/rag for model downloads) ---
HF_TOKEN=
```

## Clone the repo

```bash
# Fork first (via GitHub UI), then clone their fork
git clone git@github.com:<their-username>/Reactive_Browser_Agent.git their-pivot
cd their-pivot

# Check out the pivot point tag (detached HEAD)
git checkout PLATFORM_PIVOT_POINT

# Create a new branch from this point for their pivot work
git checkout -b vibe-coding-pivot   # or llm-training-pivot, generic-editor-pivot, etc.

# Develop freely, push when ready
git push origin vibe-coding-pivot
```

## Bring it up

```bash
cp .env.example .env                # fill in ANTHROPIC_API_KEY + HF_TOKEN
docker compose build                # first build is slow (Playwright + spaCy model)
docker compose up -d --wait
docker compose ps                   # 7 services should be healthy

# Run the agent test suite (157 tests)
docker exec agent bash -lc 'cd /workspace/services/agent && npm run check'

# Kick a ticket in for a smoke run
curl -sS -X POST http://localhost:3001/triage \
  -H 'content-type: application/json' \
  -d '{"ticketId":"T-demo","subject":"Reset password for jane@example.com"}'
# → {"runId":"...","streamUrl":"/stream/..."}

# Open the reviewer UI for that run
open http://localhost:3000/agent/review/<runId>
```

Or use the dev container: **Reopen in Container** → VS Code attaches to `agent`, Docker Compose brings up the rest.

### Host-exposed ports

- `http://localhost:3000` — test-webapp (reviewer UI + Playwright target)
- `http://localhost:3001` — agent HTTP/WS
- `http://localhost:3009/monitor` — RAG status
- `http://localhost:6333/dashboard` — Qdrant dashboard
- `postgresql://agent:agent@localhost:5432/agent`

---

## Action items outstanding

- Week 2b + 2c development continues on top of `PLATFORM_PIVOT_POINT`. See `[docs/MASTER_PLAN.md](./docs/MASTER_PLAN.md)`.

---

## License

See `[LICENSE](./LICENSE)`.