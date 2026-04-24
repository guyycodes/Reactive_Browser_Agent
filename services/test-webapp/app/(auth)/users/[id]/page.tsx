import Link from "next/link";
import { notFound } from "next/navigation";
import { getUser } from "@/lib/db";

export default function UserDetailPage({ params }: { params: { id: string } }) {
  const user = getUser(params.id);
  if (!user) notFound();

  const statusCls =
    user.status === "active" ? "ok" : user.status === "locked" ? "warn" : "err";

  return (
    <main className="page">
      <nav className="breadcrumbs" data-testid="breadcrumbs">
        <Link href="/users">Users</Link>
        <span className="crumb-sep">/</span>
        <span>{user.name}</span>
      </nav>

      <header className="page-head">
        <div>
          <h1 data-testid="user-name">{user.name}</h1>
          <p className="page-sub cell-mono" data-testid="user-email">{user.email}</p>
        </div>
        <span className={`badge ${statusCls}`} data-testid="user-status">
          {user.status}
        </span>
      </header>

      <section className="card" data-testid="user-card">
        <dl className="kv-grid">
          <dt>User ID</dt>
          <dd className="cell-mono" data-testid="user-id">{user.id}</dd>
          <dt>Department</dt>
          <dd data-testid="user-department">{user.department}</dd>
          <dt>Last login</dt>
          <dd className="cell-mono" data-testid="user-last-login">{user.lastLogin}</dd>
          <dt>Last password reset</dt>
          <dd className="cell-mono" data-testid="user-last-reset">
            {user.lastPasswordReset ?? "—"}
          </dd>
        </dl>
      </section>

      <section className="card card-destructive" data-testid="user-actions">
        <h2>Account actions</h2>
        <p className="page-sub">
          Destructive actions require explicit confirmation on the next page.
        </p>
        <div className="action-row">
          <Link
            href={`/users/${user.id}/reset-password`}
            className="btn btn-danger"
            data-testid="reset-password-link"
          >
            Reset password
          </Link>
        </div>
      </section>
    </main>
  );
}
