/**
 * Minimal template substitution engine for skill-card step args
 * (Week-2b-runtime).
 *
 * Grammar (narrow on purpose):
 *   `{{ inputs.NAME }}` where NAME matches `[a-zA-Z_][a-zA-Z0-9_]*`
 *   Whitespace inside the braces is tolerated: `{{inputs.x}}` ≡
 *   `{{ inputs.x }}`. Partial replacement is supported — e.g.
 *   `"/tickets/{{ inputs.ticket_id }}/notes"` resolves in place.
 *
 * Rejections (all throw `TemplateError` with source + position):
 *   - Unknown namespace (`{{ env.X }}`, `{{ ctx.Y }}`) — only `inputs.*`
 *     is accepted in MVP. Week-3 may add `env.*` / `ticket.*` if
 *     needed; see MASTER_PLAN polish queue.
 *   - Unknown key (`{{ inputs.missing }}` when `missing` is not in
 *     `ctx.inputs`).
 *   - Unclosed braces (`"{{ inputs.x"`).
 *   - Nested braces (`"{{ {{ }} }}"`). Fails loudly rather than
 *     silently producing garbled output.
 *
 * Zero new deps — regex + string operations only.
 *
 * The recursive deep-rendering helper `renderTemplateDeep` walks JSON
 * values (strings / objects / arrays) and renders every string leaf.
 * Non-string primitives (number, boolean, null) pass through untouched.
 * Used by the skill-card executor to resolve `step.args` before
 * dispatching to Playwright MCP.
 */

export interface TemplateContext {
  inputs: Record<string, string>;
}

export class TemplateError extends Error {
  public readonly template: string;
  public readonly position?: number;

  constructor(message: string, template: string, position?: number) {
    super(message);
    this.name = "TemplateError";
    this.template = template;
    this.position = position;
  }
}

/** Placeholder regex — CAPTURE GROUPS:
 *   1 = namespace (`inputs`)
 *   2 = key (`email`, `ticket_id`, ...)
 *  Anchored to `{{ ... }}` with optional whitespace on either side.
 *  Does NOT allow nested `{{`. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Detect unclosed or malformed `{{` / `}}` that the main regex would
 *  silently skip. Runs as a sanity pass after replacement. */
const UNCLOSED_BRACE_RE = /\{\{(?![^{}]*\}\})|(?<!\{\{[^{}]*)\}\}/;

/** Render a single string with `{{ inputs.X }}` substitution.
 *  Throws `TemplateError` on any grammar violation. */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
): string {
  if (typeof template !== "string") return template;

  // Fast path: no braces → return unchanged.
  if (!template.includes("{{")) return template;

  const output = template.replace(
    PLACEHOLDER_RE,
    (match, namespace: string, key: string, offset: number) => {
      if (namespace !== "inputs") {
        throw new TemplateError(
          `Unsupported template namespace '${namespace}' (only 'inputs.*' is accepted in Week-2b-runtime).`,
          template,
          offset,
        );
      }
      if (!(key in ctx.inputs)) {
        throw new TemplateError(
          `Template key '${namespace}.${key}' is not defined in context (available keys: ${Object.keys(ctx.inputs).join(", ") || "<none>"}).`,
          template,
          offset,
        );
      }
      return ctx.inputs[key]!;
    },
  );

  // Sanity check: after replacement, no `{{` or `}}` should remain.
  // If they do, the input had a malformed placeholder the regex skipped.
  if (UNCLOSED_BRACE_RE.test(output)) {
    throw new TemplateError(
      "Unclosed or malformed `{{ ... }}` placeholder — check grammar.",
      template,
    );
  }

  return output;
}

/** Recursively render all string leaves in a JSON-ish value. Arrays are
 *  walked element-wise; objects are walked key-value-wise (keys
 *  unchanged; only values are rendered). Non-string primitives pass
 *  through. */
export function renderTemplateDeep<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") {
    return renderTemplate(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderTemplateDeep(v, ctx)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderTemplateDeep(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}
