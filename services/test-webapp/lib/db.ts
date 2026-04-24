import seedRaw from "./seed.json";

/**
 * In-memory user store. Single-container only; state is lost on restart,
 * which is exactly what we want for a demo target. A real target app would
 * of course use Postgres.
 *
 * The agent interacts with this store exclusively via the HTTP + DOM surface
 * (login, list, reset). Nothing in the agent codebase imports from here.
 */

export type UserStatus = "active" | "locked" | "suspended";

export interface User {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  department: string;
  lastLogin: string;
  /** Set by `resetPassword`; ISO8601 string or null. */
  lastPasswordReset: string | null;
  /** Post-reset temporary password displayed once. Not persisted across reads. */
  tempPassword?: string | null;
}

const users = new Map<string, User>();
for (const seed of seedRaw as Array<Omit<User, "lastPasswordReset" | "tempPassword">>) {
  users.set(seed.id, { ...seed, lastPasswordReset: null, tempPassword: null });
}

export function listUsers(filter?: string): User[] {
  const all = Array.from(users.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (!filter) return all;
  const q = filter.toLowerCase();
  return all.filter(
    (u) =>
      u.email.toLowerCase().includes(q) ||
      u.name.toLowerCase().includes(q) ||
      u.department.toLowerCase().includes(q) ||
      u.id.toLowerCase().includes(q),
  );
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function getUserByEmail(email: string): User | undefined {
  const q = email.toLowerCase();
  for (const u of users.values()) {
    if (u.email.toLowerCase() === q) return u;
  }
  return undefined;
}

/** Reset a user's password.
 *
 *  Side effects:
 *    - `lastPasswordReset` set to `now()`
 *    - `status` moves to `active` (unlock on reset is standard for our flow)
 *    - `tempPassword` stored so the detail page can render it once
 */
export function resetPassword(id: string): User | undefined {
  const u = users.get(id);
  if (!u) return undefined;
  u.lastPasswordReset = new Date().toISOString();
  u.status = "active";
  u.tempPassword = generateTempPassword();
  users.set(id, u);
  return u;
}

function generateTempPassword(): string {
  // Deterministic-ish but non-repeating: `Temp-<3 chars><3 digits>`.
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude I/O for readability
  const num = "23456789";
  let p = "Temp-";
  for (let i = 0; i < 3; i++) p += alpha[Math.floor(Math.random() * alpha.length)];
  for (let i = 0; i < 3; i++) p += num[Math.floor(Math.random() * num.length)];
  return p;
}
