import { redirect } from "next/navigation";
import { getSessionEmail } from "@/lib/session";

/**
 * Root landing. Redirects based on session:
 *   - logged in  → /users
 *   - anonymous  → /login
 *
 * The reviewer UI lives at /agent/review/[runId] and does not require a
 * session (it's exempt from the (auth) route group).
 */
export default function Root() {
  const session = getSessionEmail();
  redirect(session ? "/users" : "/login");
}
