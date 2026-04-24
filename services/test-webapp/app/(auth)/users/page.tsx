import Link from "next/link";
import { listUsers } from "@/lib/db";

/** /users — list + search. The search input uses a normal GET form so the
 *  query lives in the URL and Playwright can navigate directly to
 *  `/users?q=jane`. Server-rendered; no client JS needed. */
export default function UsersPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = (searchParams?.q ?? "").trim();
  const users = listUsers(q || undefined);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1 data-testid="page-title">Users</h1>
          <p className="page-sub">{users.length} shown</p>
        </div>
        <form action="/users" method="get" className="search-form" data-testid="user-search-form">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search by name, email, department…"
            aria-label="Search users"
            data-testid="user-search-input"
          />
          <button type="submit" className="btn" data-testid="user-search-submit">Search</button>
        </form>
      </header>

      {users.length === 0 ? (
        <div className="empty" data-testid="users-empty">
          No users match <code>{q}</code>.{" "}
          <Link href="/users" data-testid="users-clear-search">Clear search</Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="users-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Department</th>
                <th>Status</th>
                <th>Last login</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid={`user-row-${u.id}`}>
                  <td className="cell-strong">{u.name}</td>
                  <td className="cell-mono" data-testid={`user-email-${u.id}`}>{u.email}</td>
                  <td>{u.department}</td>
                  <td>
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="cell-mono cell-dim">{formatTime(u.lastLogin)}</td>
                  <td className="cell-actions">
                    <Link
                      href={`/users/${u.id}`}
                      className="link-button"
                      data-testid={`user-view-${u.id}`}
                      aria-label={`View ${u.name} (${u.email})`}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: "active" | "locked" | "suspended" }) {
  const cls =
    status === "active" ? "ok" : status === "locked" ? "warn" : "err";
  return (
    <span className={`badge ${cls}`} data-testid={`status-${status}`}>
      {status}
    </span>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return iso;
  }
}
