import { describe, it, expect } from "vitest";

import {
  findRefByAccessibleName,
  findRefForRole,
  extractUserStatus,
} from "../src/mastra/workflows/triage.js";

/**
 * Unit coverage for the Playwright MCP snapshot ref-lookup helpers.
 *
 * These are the primary element-lookup primitive for the entire browser
 * step chain (dryRunStep + executeStep) — every `click` / `fillForm` call
 * resolves its target via `findRefByAccessibleName` or `findRefForRole`.
 * A regression here breaks Week-1B's password-reset exit criterion
 * silently (anomalies instead of clicks), so the parser gets its own
 * test file rather than being left to end-to-end smoke.
 *
 * Fixtures below are captured verbatim from @playwright/mcp@0.0.70
 * `browser_snapshot` output during the 6b-hotfix live smoke.
 */

/** /login page: a handful of labelled inputs + a submit button. */
const LOGIN_SNAPSHOT = `
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - generic [ref=e3]:
      - generic [ref=e6]: Acme IT Admin
      - heading "Sign in" [level=1] [ref=e7]
      - paragraph [ref=e8]: Internal tool · helpdesk access only
      - generic [ref=e9]:
        - generic [ref=e10]:
          - generic [ref=e11]: Email
          - textbox "Email" [ref=e12]:
            - /placeholder: admin@example.com
        - generic [ref=e13]:
          - generic [ref=e14]: Password
          - textbox "Password" [ref=e15]:
            - /placeholder: ••••••••
        - button "Sign in" [ref=e16] [cursor=pointer]
`;

/** /users search-result page after typing "jane". The View link carries
 *  `aria-label="View Jane Cooper (jane@example.com)"` (6b-hotfix-2
 *  addition) so a substring match on the email disambiguates the row.
 *
 *  Real Playwright MCP `browser_snapshot` output: rows + cells don't carry
 *  accessible-name strings (no `role "..."` prefix); only the
 *  aria-labelled link inside the cell does. That's exactly the property
 *  `findRefByAccessibleName` relies on to pick the link rather than the
 *  row.
 *
 *  The search input's role is `searchbox` — the implicit ARIA role of
 *  `<input type="search">`. Earlier fixtures had `textbox` here; 6b-hotfix-5
 *  live-smoke diagnostic confirmed the real role via the anomaly dump
 *  `searchbox "Search users" [ref=e21]`, and the production code
 *  (dryRunStep) now uses `findRefForRole("searchbox", ...)`. */
const USERS_SEARCH_SNAPSHOT = `
- main [ref=e1]:
  - heading "Users" [level=1] [ref=e2]
  - search [ref=e3]:
    - searchbox "Search users" [ref=e4]
    - button "Search" [ref=e5]
  - table [ref=e10]:
    - rowgroup [ref=e15]:
      - row [ref=e20]:
        - cell [ref=e22]: Jane Cooper
        - cell [ref=e23]: jane@example.com
        - cell [ref=e24]: Finance
        - cell [ref=e25]: locked
        - cell [ref=e26]:
          - link "View Jane Cooper (jane@example.com)" [ref=e21] [cursor=pointer]
      - row [ref=e30]:
        - cell [ref=e32]: Alex Rivera
        - cell [ref=e33]: alex@example.com
        - cell [ref=e34]: Engineering
        - cell [ref=e35]: active
        - cell [ref=e36]:
          - link "View Alex Rivera (alex@example.com)" [ref=e31] [cursor=pointer]
`;

/** /users/u-001 detail page — has a destructive "Reset password" action.
 *  Note the root's `[active]` focus marker — the whole Playwright MCP
 *  accessibility tree starts with one, and an earlier naive status
 *  regex (`/\b(active|locked|suspended)\b/`) matched it as a false
 *  positive before the 6c-2 tightening. The real status badge renders
 *  as the `- generic [ref=e53]: locked` line further down. */
const USER_DETAIL_SNAPSHOT = `
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - navigation "Breadcrumb" [ref=e3]:
      - link "Users" [ref=e4]
      - text: Jane Cooper
    - heading "Jane Cooper" [level=1] [ref=e51]
    - paragraph [ref=e52]: jane@example.com
    - generic [ref=e53]: locked
    - region "Account actions" [ref=e40]:
      - link "Reset password" [ref=e41] [cursor=pointer]
`;

/** /users/u-001/reset-password confirm page. Two "Reset password" strings
 *  on this one: the breadcrumb link AND the destructive submit button.
 *  findRefByAccessibleName returns the FIRST (breadcrumb) — callers must
 *  use findRefForRole("button", "Reset password") to get the submit. */
const RESET_CONFIRM_SNAPSHOT = `
- main [ref=e1]:
  - navigation "Breadcrumb" [ref=e2]:
    - link "Users" [ref=e3]
    - link "Jane Cooper" [ref=e4]
    - text: Reset password
  - heading "Reset password for Jane Cooper" [level=1] [ref=e10]
  - region [ref=e20]:
    - heading "This is a destructive action" [level=2] [ref=e21]
    - checkbox "I confirm I want to reset Jane Cooper's password." [ref=e30]
    - button "Reset password" [ref=e31] [cursor=pointer]
    - link "Cancel" [ref=e32]
`;

describe("findRefByAccessibleName", () => {
  it("matches an exact quoted accessible name", () => {
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "Email")).toBe("e12");
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "Password")).toBe("e15");
    // NB: on the real /login page 'Sign in' appears on both `heading` (e7)
    // and `button` (e16). findRefByAccessibleName returns the first in
    // YAML order (the heading). Callers that want the button must use
    // findRefForRole — documented in the helper's JSDoc. This is the exact
    // ambiguity that 6b-hotfix-2 solved by widening dryRunStep to use
    // role-filtered lookups.
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "Sign in")).toBe("e7");
  });

  it("is case-insensitive", () => {
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "email")).toBe("e12");
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "SIGN IN")).toBe("e7");
  });

  it("returns null when no line matches", () => {
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "Forgot password")).toBeNull();
  });

  it("returns null on empty inputs", () => {
    expect(findRefByAccessibleName("", "Email")).toBeNull();
    expect(findRefByAccessibleName(LOGIN_SNAPSHOT, "")).toBeNull();
  });

  it("substring-matches the aria-labelled View link by email", () => {
    // This is the exact call shape used in dryRunStep to disambiguate the
    // target user from 20 "View" rows — relies on the 6b-hotfix-2
    // aria-label="View <name> (<email>)" addition in
    // services/test-webapp/app/(auth)/users/page.tsx.
    expect(
      findRefByAccessibleName(USERS_SEARCH_SNAPSHOT, "jane@example.com"),
    ).toBe("e21");
    expect(
      findRefByAccessibleName(USERS_SEARCH_SNAPSHOT, "alex@example.com"),
    ).toBe("e31");
  });

  it("substring-matches the confirm-checkbox label", () => {
    // The checkbox's accessible name on the reset-confirm page is the
    // full label text; "I confirm" substring-matches regardless of the
    // target user's name.
    expect(findRefByAccessibleName(RESET_CONFIRM_SNAPSHOT, "I confirm")).toBe("e30");
  });

  it("returns the FIRST match when the same name appears on multiple lines", () => {
    // "Reset password" substring-matches both the page `heading` ("Reset
    // password for Jane Cooper") and the destructive `button` ("Reset
    // password"). findRefByAccessibleName returns the first in YAML order,
    // which is the heading (e10) — callers that need a specific role must
    // use findRefForRole. The breadcrumb's third crumb is a plain `<span>`
    // so it renders as `text: Reset password` with no ref, and correctly
    // does NOT match the regex.
    expect(findRefByAccessibleName(RESET_CONFIRM_SNAPSHOT, "Reset password")).toBe("e10");
  });

  it("ignores lines without a quoted name (role-only YAML rows)", () => {
    // Lines like `- generic [ref=e1]:` and `- text: Reset password`
    // should NOT match `Reset password` because they lack the
    // `<role> "<name>" [ref=...]` shape the regex requires.
    const onlyBareRoles = `
- generic [ref=e1]:
  - text: Reset password
  - heading [level=1] [ref=e2]
`;
    expect(findRefByAccessibleName(onlyBareRoles, "Reset password")).toBeNull();
  });
});

describe("findRefForRole", () => {
  it("filters by role and accessible name together", () => {
    // The key 6b-hotfix-2 use case: on the reset-confirm page, pick the
    // destructive `button "Reset password"` (e31), NOT the page heading
    // (e10, same substring). Without role filtering,
    // findRefByAccessibleName would click the heading and accomplish
    // nothing.
    expect(findRefForRole(RESET_CONFIRM_SNAPSHOT, "button", "Reset password")).toBe("e31");
    expect(findRefForRole(RESET_CONFIRM_SNAPSHOT, "heading", "Reset password")).toBe("e10");
  });

  it("returns null when role filter rules out every candidate", () => {
    // No link on the reset-confirm page carries 'Reset password' as its
    // accessible name (the third breadcrumb item is a `<span>`, not a link).
    expect(findRefForRole(RESET_CONFIRM_SNAPSHOT, "link", "Reset password")).toBeNull();
    expect(findRefForRole(LOGIN_SNAPSHOT, "checkbox", "Email")).toBeNull();
  });

  it("is case-insensitive on role as well as name", () => {
    expect(findRefForRole(USER_DETAIL_SNAPSHOT, "LINK", "Reset Password")).toBe("e41");
  });

  it("disambiguates the /login 'Sign in' heading from the button", () => {
    // The critical /login ambiguity: heading "Sign in" (e7) and
    // button "Sign in" (e16). Production callers must specify the role.
    expect(findRefForRole(LOGIN_SNAPSHOT, "button", "Sign in")).toBe("e16");
    expect(findRefForRole(LOGIN_SNAPSHOT, "heading", "Sign in")).toBe("e7");
  });

  it("disambiguates 'Search' substring (searchbox 'Search users' vs button 'Search')", () => {
    // Substring matching means `findRefByAccessibleName("Search")` matches
    // both `searchbox "Search users"` and `button "Search"` — first match
    // wins, so the searchbox. Production callers wanting the submit button
    // need the role filter. Regression guard against dryRunStep accidentally
    // "clicking" the search input instead of its submit.
    expect(findRefForRole(USERS_SEARCH_SNAPSHOT, "button", "Search")).toBe("e5");
    expect(findRefForRole(USERS_SEARCH_SNAPSHOT, "searchbox", "Search")).toBe("e4");
  });

  it("[6b-hotfix-5] /users search input resolves under 'searchbox' role (not 'textbox')", () => {
    // 6b-hotfix-5 regression guard: the test-webapp's search input
    // (`<input type="search" aria-label="Search users">`) has implicit
    // ARIA role `searchbox`, NOT `textbox`. A future refactor that swaps
    // dryRunStep to `findRefForRole("textbox", "Search users")` would
    // silently miss and push a "search textbox ref missing" anomaly on
    // every run — caught here at `npm run check` time instead.
    expect(findRefForRole(USERS_SEARCH_SNAPSHOT, "searchbox", "Search users")).toBe("e4");
    expect(findRefForRole(USERS_SEARCH_SNAPSHOT, "textbox", "Search users")).toBeNull();
  });
});

describe("extractUserStatus", () => {
  it("[6c-2 drive-by] matches the `- generic [ref=...]: <status>` row, not the root `[active]` marker", () => {
    // The exact false positive 6c-1 re-smoke exposed: the whole snapshot
    // starts with `- generic [active] [ref=e1]:` (that `[active]` is an
    // ARIA-like focus marker on MCP's root, NOT the status badge). An
    // earlier naive regex `/\b(active|locked|suspended)\b/` picked this
    // up and reported `user-status appears to be 'active'` on every run,
    // even when the actual badge read `locked`. The tightened regex
    // requires the status word to be the trailing text-content of a
    // `generic [ref=...]:` line, which the root's `[active]` marker
    // never is.
    expect(extractUserStatus(USER_DETAIL_SNAPSHOT)).toBe("locked");
  });

  it("returns the right status when it's 'active' (post-reset state)", () => {
    const postResetSnapshot = USER_DETAIL_SNAPSHOT.replace(
      /generic \[ref=e53\]: locked/,
      "generic [ref=e53]: active",
    );
    expect(extractUserStatus(postResetSnapshot)).toBe("active");
  });

  it("returns null on snapshots without a status badge row", () => {
    // The /login page has no user-status element; the regex must not match.
    expect(extractUserStatus(LOGIN_SNAPSHOT)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractUserStatus("")).toBeNull();
  });

  it("is NOT fooled by the root element's `[active]` focus marker alone", () => {
    // Isolated proof: a snapshot that contains the root `[active]` marker
    // but no status badge row must still return null.
    const rootOnly = `
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - heading "Something else" [level=1] [ref=e3]
`;
    expect(extractUserStatus(rootOnly)).toBeNull();
  });
});
