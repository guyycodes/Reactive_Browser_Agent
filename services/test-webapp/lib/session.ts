import { cookies } from "next/headers";

/**
 * Trivial cookie-based session for the demo target app.
 *
 * Security note: this is DEMO SCAFFOLDING. The cookie value is the user's
 * email, unsigned, unencrypted. The Playwright agent drives this flow the
 * same way any user would (navigate to /login → fill → submit → read /users)
 * so the session mechanics need to be realistic but don't need to be
 * secure. Week 4 or a real pilot would swap this for proper auth.
 */

const COOKIE_NAME = "target_session";
const ONE_HOUR_SECONDS = 60 * 60;

export function setSession(email: string): void {
  cookies().set(COOKIE_NAME, email, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_HOUR_SECONDS,
  });
}

export function clearSession(): void {
  cookies().delete(COOKIE_NAME);
}

export function getSessionEmail(): string | null {
  return cookies().get(COOKIE_NAME)?.value ?? null;
}
