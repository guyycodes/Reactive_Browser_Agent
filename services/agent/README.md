# agent service

Mastra + Playwright MCP TypeScript agent. Runs as the dev-container target: you
"Reopen in Container" on the repo root and VS Code attaches to this service.

## Container environment (verified)

Built and confirmed working in Phase 0 bring-up:

| Tool | Version / location |
|---|---|
| Node.js | `v20.20.2` |
| Playwright | `1.59.1` (Chromium installed to `/opt/ms-playwright`) |
| Xvfb | `/usr/bin/xvfb-run` |
| x11vnc | `/usr/bin/x11vnc` |
| fluxbox | `/usr/bin/fluxbox` |
| tini | `/usr/bin/tini` (PID 1) |
| socat | on PATH |
| Non-root user | `agent` (uid 1001) |
| Workspace | `/workspace` (bind-mounted from repo root) |
| Current CMD | `sleep infinity` (VS Code attaches) — real `start.sh` lands in Week 1 |

## Layout (populated in Week 1)

```
services/agent/
├── Dockerfile
├── package.json          # Mastra + Playwright MCP + Zod + Drizzle
├── src/
│   ├── index.ts          # HTTP/WS server (POST /triage, WS /stream)
│   ├── workflows/        # triage-and-execute + sub-workflows
│   ├── tools/            # rag.retrieve*, skills.load, playwright MCP client
│   ├── schemas/          # Zod: SkillCard, Ticket, Plan, Review
│   └── services/         # postgres, qdrant, rag clients
└── scripts/
    └── dev-start.sh      # Xvfb + x11vnc + node (for when you want headed mode)
```

## Inside the container

Environment (wired in `docker-compose.yml`):

- `RAG_URL=http://rag:3009`
- `QDRANT_URL=http://qdrant:6333`
- `PG_URL=postgres://agent:agent@postgres:5432/agent`
- `DISPLAY=:99` (reserved for headed Chromium; Xvfb started by `dev-start.sh`)

## Running the headed browser locally

```bash
# inside the agent container
./scripts/dev-start.sh    # launches Xvfb + x11vnc on :5900
# then open http://localhost:6080 on your host (browser-viewer bridges :5900 -> :6080)
```
