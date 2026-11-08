import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getQueueSnapshot } from "./api/dashboard";
import type { QueueResponse } from "./api/dashboard";
import "./queues.css";

type IconName = "grid" | "jobs" | "workers" | "queue" | "metrics" | "system" | "refresh" | "chevron" | "database";

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    jobs: <><path d="M8 6h12M8 12h12M8 18h12" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    workers: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /></>,
    queue: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="7" cy="6" r="2" /><circle cx="15" cy="12" r="2" /></>,
    metrics: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></>,
    system: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    refresh: <><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 9M6 15a7 7 0 0 0 12 2l2-2" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>
  };
  return <svg className="qs-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const navItems: { name: string; icon: IconName; path: string }[] = [
  { name: "Command Center", icon: "grid", path: "/" },
  { name: "Jobs", icon: "jobs", path: "/jobs" },
  { name: "Workers", icon: "workers", path: "/workers" },
  { name: "Queue", icon: "queue", path: "/queues" },
  { name: "Metrics", icon: "metrics", path: "/system" },
  { name: "System", icon: "system", path: "/system" }
];

export default function Queues() {
  const [snapshot, setSnapshot] = useState<QueueResponse | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState("ALL");

  async function refresh() {
    setLoading(true);
    try {
      setSnapshot(await getQueueSnapshot());
      setError("");
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load queue snapshot");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const counts = snapshot?.counts ?? {};
  const events = (snapshot?.events ?? []).filter((event) => {
    if (eventFilter === "ALL") return true;
    if (eventFilter === "JOBS") return event.event_type.startsWith("JOB");
    if (eventFilter === "PUBLISHED") return event.published;
    return !event.published;
  });
  const queued = counts.QUEUED ?? 0;
  const running = counts.RUNNING ?? 0;
  const failed = counts.FAILED ?? 0;
  const total = Math.max(queued + running + failed + (counts.SUCCESS ?? 0) + (counts.CANCELLED ?? 0), 1);
  const statusRows = [
    ["Queued", queued, "normal"],
    ["Running", running, "success"],
    ["Succeeded", counts.SUCCESS ?? 0, "success"],
    ["Failed", failed, "warning"],
    ["Cancelled", counts.CANCELLED ?? 0, "muted"]
  ] as const;

  return <div className="qs-shell qs-queue-page">
    <aside className="qs-sidebar">
      <div className="qs-brand"><div className="qs-brand-mark"><span /><span /><span /></div><div><strong>Job Control Plane</strong><small>MULTI-PROCESS RUNTIME</small></div></div>
      <nav><div className="qs-nav-label">CONTROL PLANE</div>{navItems.map((item) =>
        <Link key={item.name} to={item.path} className={`qs-nav-item ${item.name === "Queue" ? "active" : ""}`}><Icon name={item.icon} size={17} /><span>{item.name}</span></Link>
      )}</nav>
      <div className="qs-sidebar-foot qs-queue-status">
        <div><span>DATA SOURCE</span><strong><i className="qs-status-dot" />PostgreSQL</strong></div>
        <div><span>OUTBOX PENDING</span><strong>{snapshot?.outbox.unpublished ?? "—"}</strong></div>
      </div>
    </aside>

    <div className="qs-workspace">
      <header className="qs-topbar">
        <div className="qs-environment"><span className="qs-status-dot" />BACKEND SNAPSHOT</div>
        <div className="qs-top-actions">
          <Link className="qs-button" to="/jobs">View jobs</Link>
          <Link className="qs-button" to="/system">System health</Link>
        </div>
      </header>
      <main className="qs-main">
        <div className="qs-breadcrumb"><Link to="/">Command Center</Link><Icon name="chevron" size={12} /><span>Queue</span></div>
        <div className="qs-queue-header">
          <div><div className="qs-eyebrow">DATABASE QUEUE & OUTBOX</div><h1>Queue</h1><p>Live PostgreSQL job counts and transactional outbox events</p></div>
          <div className="qs-queue-actions">
            <span className="qs-last-updated">LAST UPDATED <strong>{updatedAt ?? "—"}</strong></span>
            <button className={`qs-auto-toggle ${autoRefresh ? "on" : ""}`} onClick={() => setAutoRefresh((value) => !value)}><span /><b>AUTO-REFRESH</b><strong>{autoRefresh ? "ON" : "OFF"}</strong></button>
            <button className="qs-button" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={14} />Refresh</button>
          </div>
        </div>

        {error && <div className="qs-panel" role="alert" style={{ padding: "1rem", marginBottom: "1rem" }}>Queue data could not be loaded: {error}</div>}

        <div className="qs-queue-kpis">
          {[
            ["QUEUED JOBS", counts.QUEUED ?? "—", "Current database count", "blue"],
            ["RUNNING JOBS", counts.RUNNING ?? "—", "Current database count", "green"],
            ["FAILED JOBS", counts.FAILED ?? "—", "Current database count", "warning"],
            ["UNPUBLISHED OUTBOX", snapshot?.outbox.unpublished ?? "—", "Awaiting publisher", "warning"]
          ].map(([label, value, detail, tone]) => <section className={`qs-kpi-card ${tone}`} key={label}>
            <div className="qs-kpi-top"><span>{label}</span><i className="qs-status-dot" /></div>
            <div className="qs-kpi-value">{value}</div>
            <div className="qs-kpi-foot"><span>{detail}</span></div>
          </section>)}
        </div>

        <div className="qs-queue-main-grid">
          <div className="qs-queue-primary">
            <section className="qs-panel">
              <div className="qs-section-header"><div><div className="qs-section-title">Persisted Job Status</div><div className="qs-section-meta">Current counts reported by the jobs table</div></div></div>
              <div className="qs-queue-table">
                <table><thead><tr><th>STATUS</th><th>JOB COUNT</th><th>DISTRIBUTION</th></tr></thead>
                  <tbody>{statusRows.map(([label, count, tone]) => <tr key={label}>
                    <td><span className={`qs-badge ${tone}`}>{label.toUpperCase()}</span></td><td>{count}</td>
                    <td><div className="qs-count-bar"><span style={{ width: `${(count * 100) / total}%` }} /></div></td>
                  </tr>)}</tbody>
                </table>
              </div>
              {loading && !snapshot && <p className="qs-section-meta">Loading queue snapshot…</p>}
            </section>

            <section className="qs-panel qs-outbox-card">
              <div className="qs-section-header"><div><div className="qs-section-title">Transactional Outbox</div><div className="qs-section-meta">Persisted outbox event publication state</div></div></div>
              <div className="qs-outbox-metrics">
                <div><span>UNPUBLISHED</span><strong>{snapshot?.outbox.unpublished ?? "—"}</strong></div>
                <div><span>PUBLISHED</span><strong>{snapshot?.outbox.published ?? "—"}</strong></div>
                <div><span>MAX ATTEMPT DURATION · 30M</span><strong>{snapshot ? `${snapshot.maxAttemptDurationMs.toFixed(0)} ms` : "—"}</strong></div>
              </div>
              <p>Redis consumer group, pending-entry, and delivery-rate telemetry is not exposed by this backend.</p>
            </section>
          </div>

          <aside className="qs-queue-secondary">
            <section className="qs-panel qs-feed-card">
              <div className="qs-section-header"><div><div className="qs-section-title">Recent Outbox Events</div><div className="qs-section-meta">Latest persisted events from PostgreSQL</div></div></div>
              <div className="qs-event-filters">
                {["ALL", "JOBS", "PUBLISHED", "UNPUBLISHED"].map((filter) => <button className={eventFilter === filter ? "active" : ""} onClick={() => setEventFilter(filter)} key={filter}>{filter}</button>)}
              </div>
              <div className="qs-event-feed">
                {events.length === 0 && <p className="qs-section-meta">{loading ? "Loading events…" : "No matching outbox events"}</p>}
                {events.map((event) => <Link key={event.id} to={`/jobs/${event.aggregate_id}`}>
                  <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                  <span className={`qs-event-kind ${event.published ? "ack" : "warn"}`}>{event.event_type}</span>
                  <strong>{event.published ? "Published" : "Unpublished"}</strong>
                  <code>{event.aggregate_id}</code>
                </Link>)}
              </div>
            </section>
            <section className="qs-panel">
              <div className="qs-section-header"><div><div className="qs-section-title">Backend Telemetry Scope</div><div className="qs-section-meta">What this page can report</div></div></div>
              <p>Queue counts, outbox publication totals, recent events, and recent maximum attempt duration come from backend database queries. Worker consumer groups and Redis pending entries are not available.</p>
              <Link className="qs-button" to="/workers">View observed worker leases</Link>
            </section>
          </aside>
        </div>
      </main>
    </div>
  </div>;
}
