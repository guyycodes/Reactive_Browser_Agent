/** /status — target-app system status dashboard.
 *
 * Static widgets. The agent's `check_system_status` skill (Week 2+) navigates
 * here and pulls green/amber/red signals off the DOM via named
 * `data-testid` hooks. For 1B the content is fixed; a future iteration can
 * seed intentional amber/red cases so the agent can escalate.
 */
export default function StatusPage() {
  const widgets: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "err";
    value: string;
    note: string;
  }> = [
    { id: "auth",         label: "Authentication",     status: "ok",   value: "operational", note: "SSO responding in 42 ms" },
    { id: "mail",         label: "Email relay",        status: "ok",   value: "operational", note: "Last successful send 12 s ago" },
    { id: "admin-portal", label: "Admin portal",       status: "ok",   value: "operational", note: "This page" },
    { id: "directory",    label: "User directory",     status: "warn", value: "degraded",    note: "Sync latency 8 min (> 5 min SLA)" },
    { id: "vpn",          label: "Corporate VPN",      status: "ok",   value: "operational", note: "2 of 3 concentrators online" },
    { id: "storage",      label: "File storage",       status: "ok",   value: "operational", note: "93% capacity" },
    { id: "billing",      label: "Billing service",    status: "err",  value: "incident",    note: "INC-20260422-004 — in progress" },
    { id: "paging",       label: "On-call paging",     status: "ok",   value: "operational", note: "PagerDuty healthy" },
  ];

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1 data-testid="page-title">System status</h1>
          <p className="page-sub">Last synced moments ago</p>
        </div>
      </header>

      <div className="status-grid" data-testid="status-grid">
        {widgets.map((w) => (
          <article
            key={w.id}
            className={`status-widget status-${w.status}`}
            data-testid={`status-widget-${w.id}`}
          >
            <header>
              <span className="status-dot" />
              <span className="status-label">{w.label}</span>
            </header>
            <div className="status-value" data-testid={`status-value-${w.id}`}>
              {w.value}
            </div>
            <p className="status-note">{w.note}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
