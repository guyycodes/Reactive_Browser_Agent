import type { Skill, SkillStep } from "../../schemas/skill-card.js";
import type { BrowserSession } from "./playwrightMcp.js";
import { PlaywrightMcpError } from "./playwrightMcp.js";
import { findRefByAccessibleName, findRefForRole } from "./domRefs.js";
import {
  renderTemplate,
  renderTemplateDeep,
  type TemplateContext,
} from "../../lib/templateEngine.js";

/**
 * Skill-card step executor (Week-2b-runtime).
 *
 * Loops over a skill's `steps[]` (or the preflight prefix — everything
 * up to but NOT INCLUDING the first step-level `destructive: true`) and
 * dispatches each step against a Playwright MCP `BrowserSession`.
 * Resolves `{{ inputs.X }}` in step args via the template engine
 * before dispatch.
 *
 * Runs under an ambient `withRunContext` scope (caller provides the
 * session + ctx); emits no workflow-level envelope frames itself —
 * the `BrowserSession` wrapper already emits `tool.started` /
 * `tool.completed` / `tool.failed` per MCP call. The caller
 * (`runDryRunStep` / `runExecuteStep`) owns the step-level
 * `step.started` / `step.completed` emissions.
 *
 * Error handling
 * --------------
 * `PlaywrightMcpError` thrown from a step dispatch (required-ref
 * miss, MCP session failure, navigate / interaction error) is caught
 * INTERNALLY by the loop: the executor appends a formatted entry to
 * `result.anomalies`, aborts the remaining steps, and returns the
 * partial `stepsRun`. Callers never see `PlaywrightMcpError` escape
 * and must not re-catch it. This preserves partial-progress telemetry
 * that would otherwise be lost on mid-flow failure (bug-2a fix).
 *
 * Other errors propagate unchanged:
 *   - `TemplateError` (unknown `{{ inputs.key }}`): skill-card
 *     authoring bug surfaces at the failing step. Caller's outer
 *     try/catch in triage.ts sees it via the `throw err;` fall-through.
 *   - `SkillInputExtractionError`: thrown by `extractInputsForSkill`
 *     BEFORE this executor is invoked (inputs are resolved once per
 *     run in triage.ts), not from within the loop.
 *
 * Template resolution is lazy per-step; a malformed arg on step 7
 * doesn't fail steps 1-6. If step 7 throws a non-Playwright error,
 * steps 8+ are not executed.
 *
 * Snapshot caching: every `click` / `fillForm` implicitly takes a
 * snapshot first (for ref resolution). The executor caches the most
 * recent snapshot text so consecutive dispatches against the same DOM
 * state don't redundant-call MCP. Invalidated after each click /
 * fillForm (which mutate DOM).
 */

export interface ExecuteSkillOptions {
  /** Preflight mode: stop BEFORE the first step-level
   *  `destructive: true`. Used by `runDryRunStep`. */
  preflight: boolean;
  /** Week-2b-runtime — when true, the executor walks the `steps[]`
   *  array but SKIPS every leading non-destructive step, beginning
   *  dispatch at the FIRST step with `destructive: true`. From that
   *  point onward every step (destructive or not) dispatches normally.
   *
   *  Used by `runExecuteStep`'s session-reuse path: when `dry_run`'s
   *  browser session is still live at execute entry, execute resumes
   *  at the destructive tail instead of re-walking the non-destructive
   *  prefix dry_run already executed. Preserves the Week-1B
   *  session-carry-over UX optimization and makes read-only skills
   *  (no destructive steps) a correct no-op at execute.
   *
   *  Invariants:
   *    - `preflight: true` + `resumeAtFirstDestructive: true` is
   *      nonsensical; asserted at entry (throws).
   *    - A skill with NO destructive step + `resumeAtFirstDestructive:
   *      true` → `stepsRun: 0` (correct no-op for read-only skills
   *      like `lookup_user`).
   *    - Liveness of `session` is the CALLER's responsibility; the
   *      executor assumes a ready-to-drive session. */
  resumeAtFirstDestructive?: boolean;
  /** Template resolution context. */
  ctx: TemplateContext;
  /** Playwright MCP session to dispatch against. */
  session: BrowserSession;
  /** Base URL to resolve relative `navigate` args against (e.g.
   *  `/login` → `${baseUrl}/login`). From the skill card's `base_url`
   *  field. */
  baseUrl: string;
}

export interface ExecuteSkillResult {
  stepsRun: number;
  /** The text content of the most recent snapshot taken during
   *  execution, or null if no snapshot was taken. Used by the caller
   *  to check postconditions after execute finishes. */
  finalSnapshot: string | null;
  /** Recoverable issues encountered during execution. Populated when a
   *  step throws `PlaywrightMcpError` (e.g. a required ref not found on
   *  the current snapshot, or the MCP session wrapper surfaces a
   *  navigation/interaction error). Each entry is formatted
   *  `step <N> (<tool>): <message>` where N is the 1-indexed position
   *  of the failing step and `tool` is the skill-card `tool:` field
   *  value. On a recorded anomaly the executor aborts the loop;
   *  `stepsRun` reflects steps that completed BEFORE the failing one.
   *  Callers use `anomalies` + `stepsRun` to derive `domMatches`
   *  (`runDryRunStep`) or the success signal (`runExecuteStep`). */
  anomalies: string[];
}

/** Extract the best-effort role filter from an element string. Skill-
 *  card conventions suffix the role word at the end of the element
 *  string: `"Sign in button"`, `"View link"`, `"I confirm checkbox"`.
 *  Returns the role string + the name with the role word stripped, or
 *  null if no role suffix is present (caller falls back to the
 *  role-free findRefByAccessibleName). */
const ROLE_SUFFIXES = new Set([
  "button",
  "link",
  "checkbox",
  "heading",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "tab",
]);

function parseRoleFromElement(
  element: string,
): { role: string; name: string } | null {
  const trimmed = element.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  const last = tokens[tokens.length - 1]?.toLowerCase();
  if (last && ROLE_SUFFIXES.has(last)) {
    const name = tokens.slice(0, -1).join(" ");
    return { role: last, name };
  }
  return null;
}

/** Resolve a skill-card `click` step's `element` string to a
 *  Playwright MCP ref via the shared snapshot. Role-filtered match is
 *  preferred when the element string carries a role suffix
 *  (disambiguates heading-vs-button on the destructive confirm page);
 *  falls back to name-only match otherwise. */
function resolveClickRef(
  snapshot: string,
  element: string,
): string | null {
  const parsed = parseRoleFromElement(element);
  if (parsed) {
    const ref = findRefForRole(snapshot, parsed.role, parsed.name);
    if (ref) return ref;
    // Role-filter miss → fall through to unfiltered match in case the
    // element string's last-word-as-role heuristic is wrong for this
    // particular card (e.g. "View link on target user row" where "row"
    // isn't the role).
  }
  return findRefByAccessibleName(snapshot, element);
}

/** Narrowed enum matching Playwright MCP's fillForm field.type. */
type FillFormFieldType = "textbox" | "checkbox" | "radio" | "combobox" | "slider";
const ALLOWED_FIELD_TYPES: ReadonlySet<FillFormFieldType> = new Set([
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "slider",
]);

function normalizeFieldType(raw: unknown): FillFormFieldType {
  if (typeof raw === "string" && ALLOWED_FIELD_TYPES.has(raw as FillFormFieldType)) {
    return raw as FillFormFieldType;
  }
  // Default — almost every test-webapp form field is a plain textbox
  // (or searchbox which Playwright MCP accepts under the "textbox"
  // contract for fillForm purposes). Checkboxes are best handled via
  // a `click` step, not fillForm.
  return "textbox";
}

/** Resolve a `fillForm` step's `fields[]` array against the current
 *  snapshot. Returns the BrowserSession.fillForm-shaped array. */
function resolveFillFormFields(
  snapshot: string,
  fields: Array<{ name: string; value: string; type?: string }>,
): Array<{ name: string; type: FillFormFieldType; ref: string; value: string }> {
  const resolved: Array<{ name: string; type: FillFormFieldType; ref: string; value: string }> = [];
  for (const field of fields) {
    // Form fields are almost always `textbox` or `searchbox`. Use
    // findRefForRole with "textbox" first; if that misses, try
    // "searchbox"; if both miss, fall through to name-only. Real
    // ambiguity beyond those is rare enough that skill-card authors
    // can split into two fillForm steps or target more specifically.
    let ref = findRefForRole(snapshot, "textbox", field.name);
    if (!ref) ref = findRefForRole(snapshot, "searchbox", field.name);
    if (!ref) ref = findRefByAccessibleName(snapshot, field.name);
    if (!ref) {
      throw new PlaywrightMcpError(
        `fillForm: could not resolve field "${field.name}" on current snapshot`,
        undefined,
        "playwright.browser_snapshot",
      );
    }
    resolved.push({
      name: field.name,
      type: normalizeFieldType(field.type),
      ref,
      value: field.value,
    });
  }
  return resolved;
}

/** Resolve the `url` arg. If it's a relative path (`/login`), prepend
 *  `baseUrl`. If it's already absolute (`http://...`), use as-is. */
function resolveNavigateUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${baseUrl.replace(/\/$/, "")}${url}`;
  return url;
}

export async function executeSkillCardSteps(
  skill: Skill,
  opts: ExecuteSkillOptions,
): Promise<ExecuteSkillResult> {
  const { session, ctx, baseUrl, preflight } = opts;

  // Invariant — preflight + resume are mutually exclusive. Documented
  // in ExecuteSkillOptions; guarded here so the folklore can't decay.
  if (preflight && opts.resumeAtFirstDestructive === true) {
    throw new Error(
      "executeSkillCardSteps: invalid options — preflight and resumeAtFirstDestructive are mutually exclusive.",
    );
  }

  const anomalies: string[] = [];
  let stepsRun = 0;
  let lastSnapshot: string | null = null;

  // Session-reuse path: skip every leading non-destructive step and
  // start dispatch at the first `destructive: true`. Flipped to false
  // once reached; subsequent steps (destructive or not) dispatch
  // normally. If the skill has NO destructive step, every step is
  // skipped → stepsRun: 0 (correct no-op for read-only skills).
  let skipPrefix = opts.resumeAtFirstDestructive === true;

  for (const step of skill.steps) {
    if (skipPrefix) {
      if (step.destructive === true) {
        skipPrefix = false;
      } else {
        continue;
      }
    }

    if (preflight && step.destructive === true) {
      // Preflight boundary — dry_run stops BEFORE the first destructive
      // step. Non-destructive steps after a destructive step (if any)
      // would also be skipped, which is intentional: dry_run is a
      // read-only preview of the preamble, not a best-effort run.
      break;
    }

    try {
      // Resolve templated args just before dispatch. A template error
      // (unknown `{{ inputs.X }}`) throws a `TemplateError` and
      // propagates — see docblock "Other errors propagate unchanged".
      const resolvedArgs = renderTemplateDeep(step.args, ctx);

      switch (step.tool) {
        case "navigate": {
          const urlRaw = (resolvedArgs as { url?: unknown }).url;
          if (typeof urlRaw !== "string" || !urlRaw) {
            throw new PlaywrightMcpError(
              "skill-card navigate step: missing args.url",
              undefined,
              "playwright.browser_navigate",
            );
          }
          await session.navigate(resolveNavigateUrl(urlRaw, baseUrl));
          lastSnapshot = null; // DOM changed
          break;
        }
        case "snapshot": {
          const snap = await session.snapshot();
          lastSnapshot = snap.text;
          break;
        }
        case "click": {
          const elementRaw = (resolvedArgs as { element?: unknown }).element;
          if (typeof elementRaw !== "string" || !elementRaw) {
            throw new PlaywrightMcpError(
              "skill-card click step: missing args.element",
              undefined,
              "playwright.browser_click",
            );
          }
          if (lastSnapshot === null) {
            const snap = await session.snapshot();
            lastSnapshot = snap.text;
          }
          const ref = resolveClickRef(lastSnapshot, elementRaw);
          if (!ref) {
            throw new PlaywrightMcpError(
              `skill-card click step: ref not found for element "${elementRaw}"`,
              undefined,
              "playwright.browser_snapshot",
            );
          }
          await session.click({ element: elementRaw, ref });
          lastSnapshot = null; // DOM likely changed
          break;
        }
        case "fillForm": {
          const fieldsRaw = (resolvedArgs as { fields?: unknown }).fields;
          if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
            throw new PlaywrightMcpError(
              "skill-card fillForm step: missing or empty args.fields[]",
              undefined,
              "playwright.browser_fill_form",
            );
          }
          const fields = fieldsRaw.map((f) => {
            const rec = f as Record<string, unknown>;
            const name = typeof rec.name === "string" ? rec.name : "";
            const value = typeof rec.value === "string" ? rec.value : "";
            const type = typeof rec.type === "string" ? rec.type : undefined;
            return { name, value, ...(type ? { type } : {}) };
          });
          if (lastSnapshot === null) {
            const snap = await session.snapshot();
            lastSnapshot = snap.text;
          }
          const resolvedFields = resolveFillFormFields(lastSnapshot, fields);
          await session.fillForm(resolvedFields);
          lastSnapshot = null; // DOM likely changed
          break;
        }
        case "takeScreenshot": {
          const labelRaw = (resolvedArgs as { label?: unknown }).label;
          const label = typeof labelRaw === "string" ? labelRaw : "unlabeled";
          await session.takeScreenshot(label);
          // takeScreenshot doesn't change DOM; lastSnapshot still valid.
          break;
        }
      }

      stepsRun++;
    } catch (err) {
      if (err instanceof PlaywrightMcpError) {
        // bug-2a fix — preserve partial-progress telemetry. Record the
        // failing step (1-indexed), abort the loop, and let the caller
        // read `anomalies` + `stepsRun` from the return value. The
        // BrowserSession wrapper has already emitted tool.failed for
        // the underlying MCP call.
        anomalies.push(`step ${stepsRun + 1} (${step.tool}): ${err.message}`);
        break;
      }
      throw err;
    }
  }

  return {
    stepsRun,
    finalSnapshot: lastSnapshot,
    anomalies,
  };
}

// Placeholder — currently unused; reserved for template parameter so
// downstream refactors can test template rendering in isolation.
export { renderTemplate };
