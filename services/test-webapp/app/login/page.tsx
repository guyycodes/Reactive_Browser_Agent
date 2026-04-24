import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionEmail, setSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/db";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  // Already logged in → skip straight to users list.
  if (getSessionEmail()) redirect("/users");

  async function loginAction(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    if (!email) redirect(`/login?error=missing-email`);
    if (!password) redirect(`/login?error=missing-password`);
    const user = getUserByEmail(email);
    if (!user) redirect(`/login?error=unknown-user`);
    // Demo: any password the form supplies is accepted. The agent uses
    // TARGET_APP_USER + TARGET_APP_PASSWORD env vars to fill this form.
    setSession(email);
    redirect("/users");
  }

  const err = searchParams?.error;

  return (
    <main className="auth-shell">
      <section className="auth-card" data-testid="login-card">
        <div className="auth-brand">
          <span className="auth-brand-dot" />
          <span>Acme IT Admin</span>
        </div>
        <h1>Sign in</h1>
        <p className="auth-subtitle">Internal tool · helpdesk access only</p>

        <form action={loginAction} className="form" data-testid="login-form">
          <label className="form-field">
            <span className="form-label">Email</span>
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              placeholder="admin@example.com"
              data-testid="login-email"
            />
          </label>

          <label className="form-field">
            <span className="form-label">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
              data-testid="login-password"
            />
          </label>

          {err && (
            <div className="form-error" role="alert" data-testid="login-error">
              {errorMessage(err)}
            </div>
          )}

          <button type="submit" className="btn btn-primary" data-testid="login-submit">
            Sign in
          </button>
        </form>

        <details className="dev-helper">
          <summary>Demo helpers</summary>
          <p>
            Any seeded email + any non-empty password works. Try{" "}
            <code>theo@example.com</code> (IT dept).
          </p>
          <p>
            Reviewer UI for agent runs:{" "}
            <Link href="/agent/review/00000000-0000-4000-8000-000000000000">
              /agent/review/&lt;runId&gt;
            </Link>
          </p>
        </details>
      </section>
    </main>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "missing-email":
      return "Email is required.";
    case "missing-password":
      return "Password is required.";
    case "unknown-user":
      return "No account found with that email.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
