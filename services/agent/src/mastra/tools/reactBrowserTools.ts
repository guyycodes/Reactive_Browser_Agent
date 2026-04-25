import { z } from "zod";

import type { ReactTool } from "../lib/reactRunner.js";
import { REACT_FINAL_SENTINEL } from "../lib/reactRunner.js";
import { getRunContext } from "../runContext.js";
import { logger } from "../../logger.js";

/**
 * week2d Part 1 — Browser ReactTools registry.
 *
 * Exposes the 5 `BrowserSession` methods that are meaningful inside a
 * ReAct reasoning loop as `ReactTool` instances, plus the `boundary_reached`
 * signal tool that an agentic dry_run step uses to tell the runner "I've
 * identified the destructive boundary; stop exploring."
 *
 * What this module does NOT do
 * ----------------------------
 *   - Emit its own envelope frames. `BrowserSession` already emits
 *     `tool.started` / `browser.*` / `tool.completed` spans via its
 *     internal `runTool` helper (`playwrightMcp.ts` ~L372-422). The
 *     runner wraps each invoke call in `withRunContext({ ...ctx, bus:
 *     taggedBus }, fn)` (reactRunner.ts L391-400) so every frame
 *     BrowserSession emits is automatically decorated with
 *     `reactIterationId`. Net-new frames from this module: ZERO.
 *
 *   - Double-screenshot stateful tools. `BrowserSession.click` and
 *     `BrowserSession.fillForm` already emit a 7a.iv implicit
 *     `${mcpToolName}:after` screenshot on success. The augmented
 *     summarize shape (`element` + `postSnapshotExcerpt`) reads
 *     post-action DOM via one cheap `snapshot()` call — not another
 *     screenshot. Reviewer UI sees the screenshot via the
 *     `browser.screenshot` frame BrowserSession emitted; the LLM's
 *     observation is text-only.
 *
 *   - Wire itself into any workflow step. Part 1 ships this as a
 *     dormant primitive. Part 2 (`runDryRunStep` rewrite) is the first
 *     consumer.
 *
 * Session access pattern
 * ----------------------
 * `requireSession()` reads `getRunContext().browser` at invoke-time
 * (not at construction-time). This late-binds to the session populated
 * by `launchBrowser` → `ctx.browser = session`. A missing session
 * throws a typed `MissingBrowserSessionError` which the runner
 * catches; the iteration records an error observation and loops.
 *
 * CTX SPREAD INVARIANT
 * --------------------
 * Every tool READS `ctx.browser`. None mutate it. Safe to invoke
 * inside any `withRunContext({ ...ctx, <override> }, fn)` scope. See
 * `runContext.ts` docblock.
 */

// ---------- Error + session access ----------

export class MissingBrowserSessionError extends Error {
  constructor() {
    super(
      "reactBrowserTools: getRunContext().browser is undefined — " +
        "did dry_run's launchBrowser run first?",
    );
    this.name = "MissingBrowserSessionError";
  }
}

function requireSession() {
  const session = getRunContext().browser;
  if (!session) throw new MissingBrowserSessionError();
  return session;
}

// ---------- Zod validators ----------

const NavigateInputSchema = z.object({
  url: z.string().url().max(2048),
});

const SnapshotInputSchema = z.object({}).passthrough();

const ClickInputSchema = z.object({
  element: z.string().min(1).max(200),
  ref: z.string().min(1).max(64),
});

/** Matches `FillFormField` at `playwrightMcp.ts` — all 4 keys required.
 *  `type` narrowed to the MCP server's accepted enum (the server
 *  rejects anything else with a hard schema error). The LLM will
 *  observe a Zod-failure observation on invalid type values and can
 *  refine — preferable to letting an invalid call reach BrowserSession
 *  and fail deeper in the stack. */
const FillFormInputSchema = z.object({
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]),
        ref: z.string().min(1).max(64),
        value: z.string().max(4096),
      }),
    )
    .min(1)
    .max(20),
});

const TakeScreenshotInputSchema = z.object({
  label: z.string().min(1).max(64),
});

const BoundaryReachedInputSchema = z.object({
  element: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
  scaffoldMatch: z.boolean().optional(),
});

// ---------- Anthropic input_schema JSON Schema ----------

const NAVIGATE_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description:
        "The URL to navigate to (absolute, including scheme). Use this to move between pages.",
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const SNAPSHOT_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const CLICK_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    element: {
      type: "string",
      description:
        "Human-readable name of the element you're clicking (e.g. 'Sign in button', 'jane@example.com link'). Used for logging and error messages.",
    },
    ref: {
      type: "string",
      description:
        "The element ref from a prior `browser_snapshot` call (e.g. 'e12'). Use `browser_snapshot` first to discover refs.",
    },
  },
  required: ["element", "ref"],
  additionalProperties: false,
} as const;

const FILL_FORM_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      description:
        "Array of form fields to fill. Each must include `name`, `type`, `ref`, `value`. `type` is enum-restricted to the Playwright MCP server's accepted form-control types.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: {
            type: "string",
            enum: ["textbox", "checkbox", "radio", "combobox", "slider"],
          },
          ref: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "type", "ref", "value"],
        additionalProperties: false,
      },
      minItems: 1,
      maxItems: 20,
    },
  },
  required: ["fields"],
  additionalProperties: false,
} as const;

const TAKE_SCREENSHOT_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description:
        "A short human-readable label for this screenshot (e.g. 'login-page', 'after-reset-confirm'). Used in filenames and the reviewer UI.",
    },
  },
  required: ["label"],
  additionalProperties: false,
} as const;

const BOUNDARY_REACHED_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    element: {
      type: "string",
      description:
        "The element name AS IT APPEARS ON TODAY'S UI (e.g. 'Reset password button', 'Update credentials button'). Use the rendered label, not the scaffold's declared name.",
    },
    reason: {
      type: "string",
      description:
        "Why you believe this element is the destructive step (e.g. 'Clicking this commits the password reset to the server').",
    },
    scaffoldMatch: {
      type: "boolean",
      description:
        "True if this element matches the scaffold's declared destructive step verbatim. False if you found a different-named-but-same-intent element (UI drift). Omit if unsure — reviewer will decide.",
    },
  },
  required: ["element", "reason"],
  additionalProperties: false,
} as const;

// ---------- Tool constructors ----------

/** Truncate + whitespace-collapse an accessibility-tree snapshot for
 *  use in an LLM observation.
 *
 *  week2d Part 2 hotfix-1 — cap raised 240 → 3000. Playwright MCP
 *  accessibility trees carry `[ref=eN]` / `[ref=bN]` tokens the agent
 *  needs to click / fillForm. A 240-char window exposed only the
 *  page title + URL, NOT the ref IDs, so the LLM silently looped on
 *  `browser_snapshot` trying to see the form structure. First live
 *  smoke hit the graceful-exhaustion path on all 3 Block-1 passes
 *  (1 navigate + 14 snapshots per pass × 3 passes) before the gate
 *  opened with exhausted banner.
 *
 *  3000 chars comfortably exposes 20-50 DOM nodes with their refs
 *  for a typical login/users page; 15 iterations × ~3KB = ~45KB
 *  observation log, well under Sonnet's context budget. The runner
 *  still slices to 400 chars for the envelope frame's
 *  `observationSummary` (reviewer-UI display), so wire payloads
 *  stay bounded. */
const EXCERPT_MAX_CHARS = 3000;
function excerpt(text: string): string {
  const collapsed = text.slice(0, EXCERPT_MAX_CHARS).replace(/\s+/g, " ");
  return text.length > EXCERPT_MAX_CHARS ? `${collapsed}…` : collapsed;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function makeNavigate(): ReactTool {
  return {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL. Use this to move between pages in the target application.",
    inputSchema: NAVIGATE_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: NavigateInputSchema,
    invoke: async (input) => {
      const { url } = input as z.infer<typeof NavigateInputSchema>;
      const session = requireSession();
      await session.navigate(url);
      return { url };
    },
    summarize: (output) => {
      const { url } = output as { url: string };
      return `navigated to ${url}`;
    },
  };
}

function makeSnapshot(): ReactTool {
  return {
    name: "browser_snapshot",
    description:
      "Read the current page's accessibility tree as text. Use this liberally to observe state — before clicking to find refs, and after clicking to verify the page changed.",
    inputSchema: SNAPSHOT_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: SnapshotInputSchema,
    invoke: async () => {
      const session = requireSession();
      const snap = await session.snapshot();
      return { text: snap.text };
    },
    summarize: (output) => {
      const { text } = output as { text: string };
      return excerpt(text);
    },
  };
}

function makeClick(): ReactTool {
  return {
    name: "browser_click",
    description:
      "Click an element identified by its accessibility ref. Call `browser_snapshot` first to find the ref.",
    inputSchema: CLICK_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: ClickInputSchema,
    invoke: async (input) => {
      const { element, ref } = input as z.infer<typeof ClickInputSchema>;
      const session = requireSession();
      // BrowserSession.click emits its own tool.started / browser.screenshot
      // (7a.iv implicit after) / tool.completed span. We don't double-
      // screenshot; a cheap snapshot() gives the LLM post-action DOM text.
      await session.click({ element, ref });
      const postSnap = await session.snapshot();
      return { element, postSnapshotExcerpt: postSnap.text };
    },
    summarize: (output) => {
      const { element, postSnapshotExcerpt } = output as {
        element: string;
        postSnapshotExcerpt: string;
      };
      return `clicked "${element}". DOM now: ${excerpt(postSnapshotExcerpt)}`;
    },
  };
}

function makeFillForm(): ReactTool {
  return {
    name: "browser_fillForm",
    description:
      "Fill a set of form fields by ref. Use `browser_snapshot` to identify each field's ref, type, and accessible name.",
    inputSchema: FILL_FORM_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: FillFormInputSchema,
    invoke: async (input) => {
      const { fields } = input as z.infer<typeof FillFormInputSchema>;
      const session = requireSession();
      await session.fillForm(fields);
      const postSnap = await session.snapshot();
      return { fieldCount: fields.length, postSnapshotExcerpt: postSnap.text };
    },
    summarize: (output) => {
      const { fieldCount, postSnapshotExcerpt } = output as {
        fieldCount: number;
        postSnapshotExcerpt: string;
      };
      return `filled ${fieldCount} field${fieldCount === 1 ? "" : "s"}. DOM now: ${excerpt(postSnapshotExcerpt)}`;
    },
  };
}

function makeTakeScreenshot(): ReactTool {
  return {
    name: "browser_takeScreenshot",
    description:
      "Capture a PNG screenshot of the current page. Use this to mark significant visual checkpoints for the reviewer.",
    inputSchema: TAKE_SCREENSHOT_INPUT_JSON_SCHEMA as unknown as Record<
      string,
      unknown
    >,
    validator: TakeScreenshotInputSchema,
    invoke: async (input) => {
      const { label } = input as z.infer<typeof TakeScreenshotInputSchema>;
      const session = requireSession();
      const result = await session.takeScreenshot(label);
      return { path: result.path, label: result.label };
    },
    summarize: (output) => {
      const { label, path } = output as { label: string; path: string };
      return `captured screenshot "${label}" → ${basename(path)}`;
    },
  };
}

/** Output shape of `boundary_reached.invoke`. Intentionally does NOT
 *  include `REACT_FINAL_SENTINEL` — the sentinel is attached via a
 *  runtime cast at the return site (see §2 rationale in
 *  `reactRunner.ts` docblock + Part 1 RFC). Keeping the sentinel off
 *  the static type preserves the existing `ReactTool<TInput, TOutput>`
 *  variance story; runtime detection in the runner is lossless. */
type BoundaryReachedOutput = {
  element: string;
  reason: string;
  scaffoldMatch: boolean | null;
  acknowledged: true;
};

function makeBoundaryReached(): ReactTool {
  return {
    name: "boundary_reached",
    description:
      "Call this tool the MOMENT you identify the destructive step that would mutate server state " +
      "(e.g., the final 'Reset password' confirm button, a 'Delete' confirmation, a 'Submit' on a " +
      "checkout form). Do NOT click the destructive element — just identify it with this tool. " +
      "After this call, dry_run completes and the human reviewer decides whether to proceed.",
    inputSchema: BOUNDARY_REACHED_INPUT_JSON_SCHEMA as unknown as Record<
      string,
      unknown
    >,
    validator: BoundaryReachedInputSchema,
    invoke: async (input) => {
      const { element, reason, scaffoldMatch } = input as z.infer<
        typeof BoundaryReachedInputSchema
      >;
      logger.info(
        { element, scaffoldMatch: scaffoldMatch ?? null },
        "[boundary_reached] dry_run agent identified destructive step",
      );
      // Runtime sentinel attach — cast hides it from the declared
      // TOutput. The runner's runtime detection pulls it back off;
      // produceOutput never sees it (iter.toolCall.output has the
      // sentinel stripped). See `reactRunner.ts` REACT_FINAL_SENTINEL.
      return {
        element,
        reason,
        scaffoldMatch: scaffoldMatch ?? null,
        acknowledged: true,
        [REACT_FINAL_SENTINEL]: true,
      } as unknown as BoundaryReachedOutput;
    },
    summarize: (output) => {
      const { element, scaffoldMatch } = output as {
        element: string;
        scaffoldMatch: boolean | null;
      };
      const match =
        scaffoldMatch === true
          ? "scaffold-match"
          : scaffoldMatch === false
            ? "DIVERGENCE"
            : "unverified";
      return `boundary_reached: ${element} [${match}]`;
    },
  };
}

/** Factory for the 6-tool registry. Keyed by Anthropic-compatible tool
 *  names. Splat into `createReActStep({ tools: { ...buildBrowserReactTools() } })`
 *  from a workflow step that wants agentic browser exploration. */
export function buildBrowserReactTools(): Record<string, ReactTool> {
  return {
    browser_navigate: makeNavigate(),
    browser_snapshot: makeSnapshot(),
    browser_click: makeClick(),
    browser_fillForm: makeFillForm(),
    browser_takeScreenshot: makeTakeScreenshot(),
    boundary_reached: makeBoundaryReached(),
  };
}
