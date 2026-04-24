import { Mastra } from "@mastra/core";
import { triageWorkflow } from "./workflows/triage.js";

/**
 * Mastra instance.
 *
 * Kept minimal for Commit 2:
 *   - No storage (in-memory; Mastra tolerates omission for non-persistent
 *     workflows, which is what we want for 1A).
 *   - No agents (Week 2 will introduce skill-card-driven agents).
 *   - No MCP servers (Week 1B adds Playwright MCP).
 *
 * The only responsibility right now is to register `triageWorkflow` so
 * Mastra's observability/inspection surfaces know about it. The workflow
 * itself is invoked through `triageWorkflow.createRun({ runId })` directly
 * (see `src/http/triage.ts`); we don't need to go through `mastra.getRunById`
 * in 1A.
 */

export const mastra = new Mastra({
  workflows: {
    triage: triageWorkflow,
  },
});

export { triageWorkflow };
export type { TriageInput, TriageOutput } from "./workflows/triage.js";
