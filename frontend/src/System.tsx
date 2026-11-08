import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getHealth, getMetrics, getReady } from "./api/system";
import type { HealthResponse, MetricsResponse, ReadyResponse } from "./api/system";
import "./job-detail.css";

type IconName = "grid" | "jobs" | "workers" | "queue" | "metrics" | "system" | "search" | "bell" | "chevron" | "refresh";

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    jobs: <><path d="M8 4h11v15H8z" /><path d="M3 8h5v11H3zM11 8h6M11 12h6M11 16h4" /></>,
    workers: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /></>,
    queue: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="7" cy="6" r="2" /><circle cx="15" cy="12" r="2" /></>,
    metrics: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></>,
    system: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    refresh: <><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 9M6 15a7 7 0 0 0 12 2l2-2" /></>
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const navItems = [
  { name: "Command Center", icon: "grid", to: "/" },
  { name: "Jobs", icon: "jobs", to: "/jobs" },
  { name: "Workers", icon: "workers", to: "/workers" },
  { name: "Queues", icon: "queue", to: "/queues" },
  { name: "Metrics", icon: "metrics", to: "/system" },
  { name: "System", icon: "system", to: "/system" }
] as const;

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}h ` : ""}${minutes ? `${minutes}m ` : ""}${Math.floor(seconds % 60)}s`;
}

export default function System() {
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [quickSearch, setQuickSearch] = useState("");

  async function refresh() {
    setLoading(true);
    const results = await Promise.allSettled([getHealth(), getReady(), getMetrics()]);
    const [healthResult, readyResult, metricsResult] = results;
    setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
    setReady(readyResult.status === "fulfilled" ? readyResult.value : null);
    setMetrics(metricsResult.status === "fulfilled" ? metricsResult.value : null);
    const failures = results.flatMap((result) => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "Request failed"]
      : []);
    setError(failures.join("; "));
    setCheckedAt(new Date().toLocaleTimeString());
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const checks = [
    ["API", health?.status === "healthy"],
    ["PostgreSQL", ready?.checks.database === "up"],
    ["Redis", ready?.checks.redis === "up"]
  ] as const;
  const systemReady = checks.every(([, isUp]) => isUp);
  const requestStats = metrics?.metrics.requests;
  const totalRequests = requestStats?.total ?? 0;
  const percentage = (value: number) => totalRequests ? `${((value / totalRequests) * 100).toFixed(1)}%` : "—";

  return <div className="jd-shell">
    <aside className="jd-sidebar">
      <div className="jd-brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>JobMesh</strong><small>MULTI-PROCESS RUNTIME</small></div></div>
      <nav>
        <div className="nav-label">CONTROL PLANE</div>
        {navItems.map((item) => <Link to={item.to} key={item.name} className={`nav-item ${item.name === "System" ? "active" : ""}`}>
          <Icon name={item.icon} size={17} /><span>{item.name}</span>
        </Link>)}
      </nav>
      <div className="sidebar-foot">
        <div className="cluster-status"><span className="status-dot" /><div><strong>{loading ? "CHECKING" : systemReady ? "READY" : "DEGRADED"}</strong><small>Live service status</small></div></div>
        <div className="build">JOBMESH <span>v1.0.0</span></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="environment"><span className="status-dot" />CONTROL PLANE</div>
        <div className="top-actions">
          <form className="search" onSubmit={(event) => { event.preventDefault(); navigate(`/jobs?search=${encodeURIComponent(quickSearch)}`); }}>
            <Icon name="search" size={15} /><input value={quickSearch} onChange={(event) => setQuickSearch(event.target.value)} placeholder="Search jobs, IDs, idempotency keys..." />
          </form>
          <Link className="icon-button notification" aria-label="View queue events" to="/queues"><Icon name="bell" /></Link>
          <Link className="profile" to="/"><span>JM</span><div><strong>JobMesh</strong><small>Command Center</small></div><Icon name="chevron" size={12} /></Link>
        </div>
      </header>

      <main>
        <div className="breadcrumb"><Link to="/">Command Center</Link><Icon name="chevron" size={12} /><span>System</span></div>
        <div className="page-header">
          <div className="page-heading">
            <div className="eyebrow">OBSERVABILITY / RUNTIME</div>
            <div className="title-row"><h1>System Operations</h1></div>
            <div className="subtitle">Live service health and API runtime metrics</div>
          </div>
          <div className="header-controls">
            <button className="button" onClick={() => setAutoRefresh((value) => !value)}>Auto refresh {autoRefresh ? "On" : "Off"}</button>
            <button className="button" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" />Refresh</button>
          </div>
        </div>

        {error && <div className="panel" role="alert" style={{ padding: "1rem", marginBottom: "1rem", color: "var(--red)" }}>Some telemetry could not be loaded: {error}</div>}
        <div className="page-grid">
          <div className="primary-column">
            <section className="panel summary-panel">
              <div className="section-header"><div><div className="section-title">Service Health</div><div className="section-meta">{checkedAt ? `Last checked ${checkedAt}` : "Waiting for first health check"}</div></div>
                <span className={`badge ${systemReady ? "success" : "failed"}`}><i className="status-dot" />{loading ? "CHECKING" : systemReady ? "READY" : "DEGRADED"}</span>
              </div>
              <div className="summary-grid">
                {checks.map(([name, isUp]) => <div className="summary-item" key={name}>
                  <span>{name}</span><strong className={isUp ? "status-text" : ""}>{loading && isUp === undefined ? "CHECKING" : isUp ? "UP" : isUp === false ? "DOWN" : "UNKNOWN"}</strong>
                </div>)}
              </div>
            </section>

            <section className="panel">
              <div className="section-header"><div><div className="section-title">Request Health</div><div className="section-meta">Counters since this API process started</div></div></div>
              <div className="summary-grid">
                {[
                  ["Total requests", String(totalRequests)],
                  ["Average latency", requestStats ? `${requestStats.averageLatencyMs.toFixed(1)} ms` : "—"],
                  ["Successful", `${requestStats?.successful ?? "—"} (${requestStats ? percentage(requestStats.successful) : "—"})`],
                  ["Client errors", `${requestStats?.clientErrors ?? "—"} (${requestStats ? percentage(requestStats.clientErrors) : "—"})`],
                  ["Server errors", `${requestStats?.serverErrors ?? "—"} (${requestStats ? percentage(requestStats.serverErrors) : "—"})`]
                ].map(([label, value]) => <div className="summary-item" key={label}><span>{label}</span><strong>{value}</strong></div>)}
              </div>
            </section>

            <section className="panel">
              <div className="section-header"><div><div className="section-title">Architecture</div><div className="section-meta">Services used by the current job pipeline</div></div></div>
              <pre style={{ background: "var(--bg)", padding: "1.25rem", border: "1px solid var(--border)", overflowX: "auto", lineHeight: 1.7 }}>
{`Client → Express API → PostgreSQL (durable jobs + outbox)
                             ↓
                       Redis Streams
                             ↓
                       Job workers`}
              </pre>
              <div className="summary-grid">
                {[
                  ["API", "Node.js + Express"],
                  ["Database", "PostgreSQL"],
                  ["Queue", "Redis Streams / Upstash"],
                  ["Delivery", "Transactional outbox + retries"]
                ].map(([name, value]) => <div className="summary-item" key={name}><span>{name}</span><strong>{value}</strong></div>)}
              </div>
            </section>
          </div>

          <aside className="diagnostics">
            <section className="panel compact-panel">
              <div className="section-header"><div><div className="section-title">Readiness</div></div></div>
              <div className="diagnostic-list">
                <div><span>Application</span><strong>{health ? "UP" : loading ? "CHECKING" : "DOWN"}</strong></div>
                <div><span>Database</span><strong>{ready?.checks.database.toUpperCase() ?? (loading ? "CHECKING" : "UNKNOWN")}</strong></div>
                <div><span>Redis</span><strong>{ready?.checks.redis.toUpperCase() ?? (loading ? "CHECKING" : "UNKNOWN")}</strong></div>
                <div><span>Process uptime</span><strong>{metrics ? formatDuration(metrics.metrics.process.uptimeSeconds) : "—"}</strong></div>
              </div>
            </section>
            <section className="panel compact-panel">
              <div className="section-header"><div><div className="section-title">Process Memory</div></div></div>
              <div className="diagnostic-list">
                <div><span>RSS</span><strong>{metrics ? formatBytes(metrics.metrics.memory.rss) : "—"}</strong></div>
                <div><span>Heap used</span><strong>{metrics ? formatBytes(metrics.metrics.memory.heapUsed) : "—"}</strong></div>
                <div><span>Heap total</span><strong>{metrics ? formatBytes(metrics.metrics.memory.heapTotal) : "—"}</strong></div>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  </div>;
}
