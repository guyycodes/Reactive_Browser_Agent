#!/usr/bin/env tsx
/**
 * embed-skill-cards.ts (Week-2b foundation)
 *
 * Walks `kb/skill_cards/`, composes an HTML prose block per skill, and
 * uploads each block to `rag:3009/docs/upload/documents` with the
 * filename tagged by `SHARED_SKILLS_UUID` from `.env`. The rag pipeline
 * routes all same-UUID files to the same Qdrant collection (append
 * semantics per Phase 0.5's filename-UUID convention — see
 * `services/rag/src/util/queue.py:tag_filename_with_uuid`).
 *
 * Usage:
 *   npm run embed:skill-cards            # from services/agent/
 *   tsx scripts/embed-skill-cards.ts <path>  # explicit directory
 *
 * One-shot tool, not a runtime hot-path — no circuit-breaker wrapper
 * (unlike the per-run `retrieveSkills` query). Fails loudly on the
 * first upload error.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { env } from "../src/env.js";
import {
  SkillCardSchema,
  type SkillCard,
  type Skill,
} from "../src/schemas/skill-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_KB_PATH = path.join(REPO_ROOT, "kb", "skill_cards");

export interface EmbedResult {
  uploaded: number;
  skipped: number;
}

export interface EmbedOptions {
  ragUrl?: string;
  skillsUuid?: string;
  fetchImpl?: typeof fetch;
}

async function walkYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkYaml(p)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
    ) {
      out.push(p);
    }
  }
  return out;
}

/** Escape HTML special chars so free-text fields (preconditions etc.)
 *  can't inject markup into the composed document the rag pipeline
 *  ingests. Narrow set sufficient for the skill-card content the
 *  validation schema permits (no URLs, no arbitrary HTML). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function composeSkillProse(card: SkillCard, skill: Skill): string {
  const lines: string[] = [];
  lines.push("<html><body>");
  lines.push(`<h1>Skill: ${escapeHtml(skill.name)}</h1>`);
  lines.push(`<p><strong>App:</strong> ${escapeHtml(card.app)}</p>`);
  lines.push(
    `<p><strong>Destructive:</strong> ${skill.destructive ? "yes" : "no"}</p>`,
  );
  lines.push("<h2>Description</h2>");
  lines.push(`<p>${escapeHtml(skill.description)}</p>`);
  if (skill.preconditions && skill.preconditions.length > 0) {
    lines.push("<h2>Preconditions</h2><ul>");
    for (const p of skill.preconditions) lines.push(`<li>${escapeHtml(p)}</li>`);
    lines.push("</ul>");
  }
  if (skill.postconditions && skill.postconditions.length > 0) {
    lines.push("<h2>Postconditions</h2><ul>");
    for (const p of skill.postconditions) lines.push(`<li>${escapeHtml(p)}</li>`);
    lines.push("</ul>");
  }
  lines.push("</body></html>");
  return lines.join("\n");
}

export async function embedSkillCards(
  kbPath: string,
  opts: EmbedOptions = {},
): Promise<EmbedResult> {
  const ragUrl = opts.ragUrl ?? env.RAG_URL;
  const skillsUuid = opts.skillsUuid ?? env.SHARED_SKILLS_UUID;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const files = await walkYaml(kbPath);
  let uploaded = 0;
  let skipped = 0;

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const parsed = yaml.load(raw);
    const result = SkillCardSchema.safeParse(parsed);
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.error(`[embed-skill-cards] skipping malformed ${file}`);
      skipped++;
      continue;
    }
    const card = result.data;
    for (const skill of card.skills) {
      const filename = `skill_${card.app}_${skill.name}_${skillsUuid}.html`;
      const html = composeSkillProse(card, skill);

      const form = new FormData();
      const blob = new Blob([html], { type: "text/html" });
      // Field name is singular "file" — matches the FastAPI handler
      // signature at services/rag/controllers/upload_controller.py:
      //   async def upload_file(..., file: UploadFile = File(...), ...)
      // Plural "files" produces HTTP 422 (FastAPI reports the `file`
      // field as required). Caught by week2b-foundation-hotfix-1 smoke
      // against the live RAG endpoint.
      form.append("file", blob, filename);

      const resp = await fetchImpl(`${ragUrl}/docs/upload/documents`, {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const detail = await resp
          .text()
          .catch(() => "<unreadable>");
        throw new Error(
          `rag upload failed (HTTP ${resp.status}) for ${filename}: ${detail.slice(0, 300)}`,
        );
      }
      uploaded++;
      // eslint-disable-next-line no-console
      console.log(`  ↑ ${filename}`);
    }
  }
  return { uploaded, skipped };
}

async function main(): Promise<void> {
  const kbPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_KB_PATH;
  // eslint-disable-next-line no-console
  console.log(
    `[embed-skill-cards] kbPath=${kbPath} ragUrl=${env.RAG_URL} skillsUuid=${env.SHARED_SKILLS_UUID}`,
  );
  const result = await embedSkillCards(kbPath);
  // eslint-disable-next-line no-console
  console.log(
    `✓ ${result.uploaded} skill prose block${result.uploaded === 1 ? "" : "s"} uploaded (${result.skipped} skipped)`,
  );
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
