import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionEmail, clearSession } from "@/lib/session";

/**
 * Auth-gated layout. Wraps every page under `app/(auth)/…` with a session
 * check + a top nav bar. The `(auth)` route group prefix is stripped from
 * URLs, so routes below still live at `/users`, `/status`, etc.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const email = getSessionEmail();
  if (!email) redirect("/login");

  async function logoutAction() {
    "use server";
    clearSession();
    redirect("/login");
  }

  return (
    <div className="app-shell">
      <header className="app-nav" data-testid="app-nav">
        <div className="app-nav-inner">
          <Link href="/users" className="app-brand" data-testid="nav-brand">
            <span className="app-brand-dot" />
            <span>Acme IT Admin</span>
          </Link>
          <nav className="app-nav-links">
            <Link href="/users" data-testid="nav-users">Users</Link>
            <Link href="/status" data-testid="nav-status">System status</Link>
          </nav>
          <form action={logoutAction} className="app-logout">
            <span className="app-session" data-testid="session-email">{email}</span>
            <button type="submit" className="btn-ghost" data-testid="nav-logout">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className="app-main">{children}</div>
    </div>
  );
}
