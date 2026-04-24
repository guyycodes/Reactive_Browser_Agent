import { describe, it, expect } from "vitest";

import { staticRouter, type StaticFsLike } from "../src/http/static.js";

/**
 * Commit 6c-2 coverage for the `/static/runs/:runId/:filename` route.
 *
 * Scope (per reviewer handoff):
 *   1. Happy PNG serve — 200 + image/png Content-Type + body + cache header.
 *   2. Path-traversal rejection — `..` / absolute / backslash in filename
 *      all fail the whitelist at the Zod layer before any fs access.
 *   3. 404 on missing file — ENOENT from fsImpl resolves as 404.
 *   4. Extension whitelist — `.exe` / `.html` / no-extension refused 400.
 *
 * Dependency-free: we inject `fsImpl` so no real fs access and no temp
 * directory management. Matches `rag.ts`'s fetchImpl pattern and
 * `playwrightMcp.ts`'s clientFactory pattern.
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RUNS_ROOT = "/workspace/.playwright-videos";

type FsCall = { path: string };

function makeMockFs(
  files: Record<string, Buffer>,
): { fs: StaticFsLike; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const fs: StaticFsLike = {
    async readFile(absolutePath: string): Promise<Buffer> {
      calls.push({ path: absolutePath });
      const hit = files[absolutePath];
      if (hit) return hit;
      const err = new Error(`ENOENT: ${absolutePath}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  };
  return { fs, calls };
}

/** Fake PNG magic bytes — header is all we assert on. */
const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // IHDR
]);

describe("staticRouter — /runs/:runId/:filename", () => {
  it("[1] happy path: 200 + image/png + body + cache header for a seq-numbered PNG", async () => {
    const absolutePath = `${RUNS_ROOT}/${RUN_ID}/42.png`;
    const { fs, calls } = makeMockFs({ [absolutePath]: FAKE_PNG });

    const app = staticRouter({ runsRoot: RUNS_ROOT, fsImpl: fs });
    const res = await app.request(`/runs/${RUN_ID}/42.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(FAKE_PNG)).toBe(true);

    // Filesystem was asked for the exact expected path — not something
    // path.resolve mangled.
    expect(calls).toEqual([{ path: absolutePath }]);
  });

  it("[2] path-traversal attempts are rejected at the filename whitelist (400, no fs access)", async () => {
    const { fs, calls } = makeMockFs({});
    const app = staticRouter({ runsRoot: RUNS_ROOT, fsImpl: fs });

    // URL-encoded traversal — Hono decodes the param before routing.
    const encodedDotDot = await app.request(
      `/runs/${RUN_ID}/..%2F..%2Fetc%2Fpasswd`,
    );
    expect(encodedDotDot.status).toBe(400);

    // Explicit `..` substring in the filename (after decoding, the actual
    // param value). Even a literal `..png` starts with a dot which the
    // whitelist forbids.
    const literalDots = await app.request(`/runs/${RUN_ID}/..png`);
    expect(literalDots.status).toBe(400);

    // Backslash — Windows-style separator we also refuse.
    const backslash = await app.request(`/runs/${RUN_ID}/foo%5Cbar.png`);
    expect(backslash.status).toBe(400);

    // Absolute-path attempt. Hono's :filename param doesn't match `/`, so
    // this actually returns a route 404 (no handler), not a 400. Either
    // shape is fine — we just need "no fs access, no bytes returned".
    const absPath = await app.request(`/runs/${RUN_ID}//etc/passwd`);
    expect([400, 404]).toContain(absPath.status);

    // Critically: none of these hit the fs.
    expect(calls.length).toBe(0);
  });

  it("[3] missing file: 404 when fsImpl throws ENOENT", async () => {
    const { fs } = makeMockFs({}); // empty — every read throws ENOENT
    const app = staticRouter({ runsRoot: RUNS_ROOT, fsImpl: fs });

    const res = await app.request(`/runs/${RUN_ID}/missing.png`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  it("[4] extension whitelist: non-png / no-ext / exe returns 400", async () => {
    const { fs, calls } = makeMockFs({});
    const app = staticRouter({ runsRoot: RUNS_ROOT, fsImpl: fs });

    const exe = await app.request(`/runs/${RUN_ID}/payload.exe`);
    expect(exe.status).toBe(400);

    const html = await app.request(`/runs/${RUN_ID}/index.html`);
    expect(html.status).toBe(400);

    // No extension at all — passes the filename regex but fails the
    // extension whitelist (prevents accidentally serving dotfile-free
    // profile artifacts like `Cookies` or `Local State`).
    const noExt = await app.request(`/runs/${RUN_ID}/Cookies`);
    expect(noExt.status).toBe(400);

    // Valid whitelist extensions all resolve past the guard — they just
    // 404 because we didn't seed content.
    const yml = await app.request(`/runs/${RUN_ID}/run.yml`);
    expect(yml.status).toBe(404);
    const log = await app.request(`/runs/${RUN_ID}/run.log`);
    expect(log.status).toBe(404);

    // fs was only hit for the two valid-extension 404s, not for the
    // rejected extensions.
    expect(calls.length).toBe(2);
  });

  it("[5] invalid runId (not a UUID) is rejected with 400", async () => {
    const { fs, calls } = makeMockFs({});
    const app = staticRouter({ runsRoot: RUNS_ROOT, fsImpl: fs });

    const res = await app.request("/runs/not-a-uuid/42.png");
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});
