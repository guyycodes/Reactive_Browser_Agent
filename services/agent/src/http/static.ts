import { Hono } from "hono";
import { z } from "zod";
import * as path from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";

import { logger } from "../logger.js";

/**
 * Static-file route for Commit 6c: serves per-run screenshots (and other
 * artifacts) produced by `@playwright/mcp` under the shared
 * `playwright-videos` volume. The reviewer UI's `<img src="/api/static/…">`
 * hits this route (via a Next.js rewrite from `test-webapp:3000` →
 * `agent:3001`) to display frames inline in the run timeline.
 *
 * Surface
 * -------
 *   GET /static/runs/:runId/:filename → 200 + file bytes + Content-Type
 *                                        404 if the file doesn't exist
 *                                        400 on invalid runId / filename
 *
 * Security posture
 * ----------------
 * 1. `runId` is Zod-parsed as a canonical UUID (same as `http/runs.ts`).
 * 2. `filename` is whitelisted to `[A-Za-z0-9][A-Za-z0-9._-]*` with a
 *    known-extension suffix (png / jpeg / jpg / yml / yaml / log) — so
 *    request paths like `../../etc/passwd`, `.mcp-profile/Cookies`, or any
 *    path-traversal attempt fail the filename regex BEFORE path.resolve
 *    runs. The `.mcp-profile/` directory (6c-1) is dot-prefixed and its
 *    children aren't addressable through this route.
 * 3. Defense in depth: after the whitelist, `path.resolve(root, runId,
 *    filename)` is required to start with the resolved per-run directory
 *    and nothing else. If symlinks or weird pathing ever produce a file
 *    outside the run tree, we refuse.
 * 4. The route does NOT list directories and does NOT expose run metadata.
 *    Callers already know which filename to ask for (from the
 *    `browser.screenshot` frame's `path` field).
 *
 * Caching
 * -------
 * `Cache-Control: private, max-age=3600` — per-run screenshots are
 * content-immutable (we write `<seq>.png` once, never overwrite) so a
 * 1-hour cache is safe and cuts the round-trip cost when a reviewer
 * refreshes their timeline. `private` keeps it out of shared proxy caches.
 *
 * Not responsibilities
 * --------------------
 * - WebSocket origin enforcement lives on `/stream/*` (see `events/stream.ts`).
 *   This route is browser-fetched from the test-webapp's rewrite proxy;
 *   origin pinning there can be added in Week 3 alongside the real auth
 *   story. For 1B the route is read-only on immutable artifacts so the
 *   exposure surface is bounded.
 * - Authentication. Week 3.
 */

const uuidParam = z.string().uuid();

/** Filename whitelist: must start with an alphanumeric and contain only
 *  `[A-Za-z0-9._-]` — enough for sequence-numbered screenshots (`42.png`),
 *  labelled artifacts (`users-list.yml`), and log snippets (`run.log`).
 *  Explicitly rules out `..`, `/`, `\`, leading dots, and URL-decoded
 *  traversal tokens. */
const filenameParam = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "invalid filename characters");

/** Known screenshot/artifact extensions. Anything else is a 404-shaped 400
 *  so misconfigured client code fails loud rather than trying to serve
 *  arbitrary binary from the volume. */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  yml: "application/x-yaml",
  yaml: "application/x-yaml",
  log: "text/plain; charset=utf-8",
};

/** Minimal filesystem surface this router depends on. Exposed so the unit
 *  test can inject an in-memory mock without touching disk — same pattern
 *  as `rag.ts`'s `fetchImpl` and `playwrightMcp.ts`'s `clientFactory`. */
export interface StaticFsLike {
  readFile(absolutePath: string): Promise<Buffer>;
}

export interface StaticRouterOptions {
  /** Absolute path under which per-run directories live. In production:
   *  `/workspace/.playwright-videos`. Each `runId` resolves to a
   *  `<runsRoot>/<runId>/` directory; this router serves files from there. */
  runsRoot: string;
  /** Test-only fs override. Defaults to `node:fs/promises.readFile`. */
  fsImpl?: StaticFsLike;
}

export function staticRouter(opts: StaticRouterOptions): Hono {
  const app = new Hono();
  const fs = opts.fsImpl ?? { readFile: fsReadFile };
  const resolvedRoot = path.resolve(opts.runsRoot);

  app.get("/runs/:runId/:filename", async (c) => {
    const runIdParam = uuidParam.safeParse(c.req.param("runId"));
    if (!runIdParam.success) {
      return c.json({ error: "invalid run id" }, 400);
    }
    const runId = runIdParam.data;

    const filenameRaw = c.req.param("filename") ?? "";
    const filenameParsed = filenameParam.safeParse(filenameRaw);
    if (!filenameParsed.success) {
      return c.json(
        { error: "invalid filename", issues: filenameParsed.error.issues },
        400,
      );
    }
    const filename = filenameParsed.data;

    // Extension guard — `.mcp-profile` is dot-prefixed (no extension), so
    // even if the whitelist accidentally admitted its children they'd 404
    // here. Belt and suspenders.
    const dotIdx = filename.lastIndexOf(".");
    const ext = dotIdx > 0 ? filename.slice(dotIdx + 1).toLowerCase() : "";
    const contentType = EXTENSION_CONTENT_TYPES[ext];
    if (!contentType) {
      return c.json({ error: "unsupported file type" }, 400);
    }

    // Resolve + defense-in-depth containment check. If `path.resolve` ever
    // produces anything outside the per-run directory (symlinks, odd
    // unicode normalization, platform pathing), we refuse rather than
    // guess.
    const resolvedRunDir = path.resolve(resolvedRoot, runId);
    const resolvedFile = path.resolve(resolvedRunDir, filename);
    const requiredPrefix = resolvedRunDir + path.sep;
    if (!resolvedFile.startsWith(requiredPrefix)) {
      logger.warn(
        { runId, filename, resolvedFile, resolvedRunDir },
        "[static] path resolved outside run dir; refusing",
      );
      return c.json({ error: "path outside run dir" }, 400);
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(resolvedFile);
    } catch (err) {
      const isEnoent = isNoEnt(err);
      if (isEnoent) {
        return c.json({ error: "not found" }, 404);
      }
      logger.error(
        { runId, filename, err },
        "[static] file read failed with non-ENOENT error",
      );
      return c.json({ error: "internal error" }, 500);
    }

    // Hono 4.6's `c.body` wants `Uint8Array<ArrayBuffer>`. Node's `Buffer`
    // is a `Uint8Array<ArrayBufferLike>` (it supports SharedArrayBuffer
    // backing), which the type system rightly refuses. Copy into a fresh
    // Uint8Array with a plain ArrayBuffer backing — cheap, one alloc
    // per request, simpler than fighting the generics.
    const payload = new Uint8Array(bytes.byteLength);
    payload.set(bytes);

    return c.body(payload, 200, {
      "Content-Type": contentType,
      "Content-Length": String(payload.byteLength),
      "Cache-Control": "private, max-age=3600",
    });
  });

  return app;
}

function isNoEnt(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
