/**
 * Playwright MCP accessibility-tree ref-lookup helpers.
 *
 * Extracted from `workflows/triage.ts` in Week-2b-runtime so the
 * skill-card executor (`skillCardExecutor.ts`) can import without a
 * circular dep back to the workflow. Pure functions — zero side
 * effects, zero runtime deps.
 *
 * Playwright MCP's `browser_snapshot` returns an accessibility tree as
 * text, with lines like:
 *
 *     textbox "Email" [ref=e12]
 *     button "Sign in" [ref=e16] [cursor=pointer]
 *     link "View Jane Cooper (jane@example.com)" [ref=e54] [cursor=pointer]
 *
 * It does NOT expose `data-testid` attributes — only role, accessible
 * name, and ref. Callers pass a `needle` (the accessible name or a
 * substring of it) and optionally a `role` filter; the helper returns
 * the matching `ref` (e.g. `e16`) or `null`.
 *
 * Unit coverage: `test/findRef.test.ts` (20 cases including every
 * role-ambiguity edge case caught during the 6b-hotfix smoke).
 */

/** Match a snapshot line and return the ref. Shared implementation
 *  used by both name-only and role-filtered variants. */
function matchSnapshot(
  snapshot: string,
  needle: string,
  roleFilter: string | null,
): string | null {
  if (!snapshot || !needle) return null;
  const needleLower = needle.toLowerCase();
  // Capture: 1 = role, 2 = accessible name, 3 = ref
  //
  // Lazy `.*?` between the quoted name and `[ref=...]` because a line may
  // carry multiple bracketed attributes before the ref token, e.g.:
  //     heading "Reset password for Jane" [level=1] [ref=e10]
  //     button "Sign in" [ref=e16] [cursor=pointer]
  //     link "View Jane (jane@example.com)" [ref=e21] [cursor=pointer]
  const lineRe = /^\s*(?:- )?(\S+)\s+"([^"]+)".*?\[ref=([a-z0-9_-]+)\]/i;
  for (const line of snapshot.split("\n")) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const role = (m[1] ?? "").toLowerCase();
    const name = (m[2] ?? "").toLowerCase();
    const ref = m[3];
    if (!ref) continue;
    if (roleFilter && role !== roleFilter) continue;
    if (name.includes(needleLower)) return ref;
  }
  return null;
}

/** Find a ref by accessible-name substring across ALL roles. Earliest
 *  matching line wins. Returns `null` if no match. */
export function findRefByAccessibleName(
  snapshot: string,
  needle: string,
): string | null {
  return matchSnapshot(snapshot, needle, null);
}

/** Role-filtered variant. Needed on pages where the same accessible
 *  name appears on two different roles (e.g. the reset-password
 *  confirm page has a breadcrumb `link "Reset password"` AND a
 *  destructive `button "Reset password"` — plain
 *  `findRefByAccessibleName` returns the first match in YAML order,
 *  which is the link, not the button we want to click). Pass
 *  `role="button"` to filter. */
export function findRefForRole(
  snapshot: string,
  role: string,
  needle: string,
): string | null {
  return matchSnapshot(snapshot, needle, role.toLowerCase());
}
