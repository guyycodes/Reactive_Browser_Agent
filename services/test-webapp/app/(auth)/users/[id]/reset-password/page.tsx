import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getUser, resetPassword } from "@/lib/db";

/**
 * Destructive action page: reset a user's password.
 *
 * Two-state page:
 *   - Default: renders a confirm-checkbox + Reset button. The checkbox is
 *     `required` so native HTML form validation prevents submission until
 *     checked. Server action calls resetPassword() + redirects with
 *     ?done=1.
 *   - `?done=1`: renders the success state with the temp password + a link
 *     back to the user detail.
 *
 * Design choices for Playwright
 *   - No JavaScript `confirm()` dialogs (those aren't in the accessibility
 *     tree and require a dialog-handler in MCP).
 *   - Confirm-via-checkbox is DOM-drivable: check the box, click the button.
 *   - Stable `data-testid` on every interactive element.
 *   - Success state has `data-testid="reset-success"` + `data-testid="temp-password"`
 *     so the agent's verify step can pull the post-condition from the DOM.
 */
export default function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { done?: string };
}) {
  const user = getUser(params.id);
  if (!user) notFound();

  const done = searchParams?.done === "1";

  async function resetAction(formData: FormData) {
    "use server";
    const confirm = formData.get("confirm");
    if (confirm !== "on") {
      redirect(`/users/${params.id}/reset-password?error=unconfirmed`);
    }
    resetPassword(params.id);
    redirect(`/users/${params.id}/reset-password?done=1`);
  }

  if (done) {
    return (
      <main className="page">
        <nav className="breadcrumbs" data-testid="breadcrumbs">
          <Link href="/users">Users</Link>
          <span className="crumb-sep">/</span>
          <Link href={`/users/${user.id}`}>{user.name}</Link>
          <span className="crumb-sep">/</span>
          <span>Reset password</span>
        </nav>

        <div className="toast toast-ok" role="status" data-testid="reset-success">
          <span className="toast-icon">✓</span>
          <div>
            <strong>Password reset successful</strong>
            <p>
              {user.name}&rsquo;s password has been reset. Their account status is
              now <code>active</code>.
            </p>
          </div>
        </div>

        <section className="card" data-testid="temp-password-card">
          <h2>Temporary password</h2>
          <p className="page-sub">Share with the user via a secure channel. Prompt them to change it on first sign-in.</p>
          <div className="temp-pw" data-testid="temp-password">
            <code>{user.tempPassword ?? "—"}</code>
          </div>
        </section>

        <div className="action-row">
          <Link href={`/users/${user.id}`} className="btn" data-testid="back-to-user">
            Back to {user.name}
          </Link>
          <Link href="/users" className="btn-ghost" data-testid="back-to-users">
            Users list
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <nav className="breadcrumbs" data-testid="breadcrumbs">
        <Link href="/users">Users</Link>
        <span className="crumb-sep">/</span>
        <Link href={`/users/${user.id}`}>{user.name}</Link>
        <span className="crumb-sep">/</span>
        <span>Reset password</span>
      </nav>

      <header className="page-head">
        <div>
          <h1 data-testid="reset-heading">
            Reset password for {user.name}
          </h1>
          <p className="page-sub cell-mono" data-testid="reset-email">{user.email}</p>
        </div>
      </header>

      <section className="card card-destructive" data-testid="reset-warning">
        <h2>This is a destructive action</h2>
        <ul className="warn-list">
          <li>The current password will be invalidated immediately.</li>
          <li>A temporary password will be generated and shown once.</li>
          <li>The account status will be set to <code>active</code>.</li>
        </ul>

        <form action={resetAction} className="form" data-testid="reset-form">
          <label className="form-field form-check">
            <input
              type="checkbox"
              name="confirm"
              required
              data-testid="reset-confirm-check"
            />
            <span>
              I confirm I want to reset <strong>{user.name}</strong>&rsquo;s password.
            </span>
          </label>

          <div className="action-row">
            <button
              type="submit"
              className="btn btn-danger"
              data-testid="reset-submit"
            >
              Reset password
            </button>
            <Link href={`/users/${user.id}`} className="btn-ghost" data-testid="reset-cancel">
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </main>
  );
}
