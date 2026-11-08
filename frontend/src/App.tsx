import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getOverview } from "./api/dashboard";
import type { Job as ApiJob } from "./api/jobs";
import { getHealth, getReady, subscribeToRequestMetrics } from "./api/system";
import type { HealthResponse, ReadyResponse } from "./api/system";

type IconName =
  | "activity" | "alert" | "bell" | "bolt" | "box" | "chart" | "check"
  | "chevron" | "clock" | "database" | "event" | "eye" | "grid" | "heart"
  | "jobs" | "menu" | "plus" | "queue" | "refresh" | "retry" | "search"
  | "server" | "settings" | "users" | "x";

const iconPaths: Record<IconName, ReactNode> = {
  activity: <><path d="M4 12h3l2-6 4 12 2-6h5" /></>,
  alert: <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 16.5v.1" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  bolt: <><path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" /></>,
  box: <><path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z" /><path d="m4 7 8 4 8-4M12 11v10" /></>,
  chart: <><path d="M4 19V5M4 19h16M7 15l4-5 3 2 5-7" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
  event: <><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  heart: <><path d="M4 12h3l2-5 4 10 2-5h5" /><circle cx="12" cy="12" r="10" /></>,
  jobs: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  queue: <><path d="M6 6h14M6 12h14M6 18h14" /><circle cx="3" cy="6" r=".6" /><circle cx="3" cy="12" r=".6" /><circle cx="3" cy="18" r=".6" /></>,
  refresh: <><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18.5 9A7.5 7.5 0 0 0 6 6.5L4 9M5.5 15A7.5 7.5 0 0 0 18 17.5l2-2.5" /></>,
  retry: <><path d="M20 7v5h-5M19 12a7 7 0 1 1-2-5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.1M7 17h.1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" /></>,
  x: <><path d="m6 6 12 12M18 6 6 18" /></>,
};

function Icon({ name, size = 16, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}

function Button({ children, variant = "secondary", icon, onClick, loading, type = "button" }: {
  children: ReactNode; variant?: "primary" | "secondary" | "ghost" | "danger"; icon?: IconName;
  onClick?: () => void; loading?: boolean; type?: "button" | "submit";
}) {
  return <button type={type} className={`btn btn-${variant}`} onClick={onClick}>
    {icon && <Icon name={icon} className={loading ? "spin" : ""} />}{children}
  </button>;
}

type Worker = { id: string; jobs: number; status: "ACTIVE" | "STALE"; heartbeat: number };
type JobStatus = "SUCCESS" | "RUNNING" | "FAILED" | "QUEUED" | "CANCELLED";
type Job = { status: JobStatus; id: string; type: string; worker: string; attempt: string; age: number; duration: string; idempotencyKey: string };
type EventLog = { type: string; text: string; time: string; tone: string };

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status.toLowerCase()}`}><i />{status}</span>;
}

function MetricCard({ label, value, detail, icon, tone = "normal", trend }: {
  label: string; value: string | number; detail?: string; icon: IconName; tone?: string; trend?: string;
}) {
  return <section className={`metric card tone-${tone}`}>
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon} /></span></div>
    <div className="metric-value">{value}</div>
    <div className="metric-foot">
      {trend && trend !== "—" && <span className="trend">{trend}</span>}
      {detail && <span>{detail}</span>}
    </div>
  </section>;
}

function ThroughputChart({ values, failedValues, range, setRange }: { values: number[]; failedValues: number[]; range: string; setRange: (v: string) => void }) {
  const width = 760, height = 220;
  const rangeMinutes: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60, "6h": 360, "24h": 1440 };
  const minutes = rangeMinutes[range] ?? 15;
  const timeLabel = (fraction: number) => new Date(Date.now() - minutes * 60000 * (1 - fraction)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const maxValue = Math.max(...values, ...failedValues, 1);
  const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * width},${height - (v / maxValue) * height}`).join(" ");
  const failed = failedValues.map((v, i) => `${(i / Math.max(failedValues.length - 1, 1)) * width},${height - (v / maxValue) * height}`).join(" ");
  const area = `0,${height} ${points} ${width},${height}`;
  return <section className="card chart-card">
    <div className="card-head">
      <div><div className="section-title">Job Throughput</div><div className="section-subtitle">Jobs created and failed per bucket</div></div>
      <div className="range-control">{["5m", "15m", "1h", "6h", "24h"].map(r => <button key={r} onClick={() => setRange(r)} className={range === r ? "active" : ""}>{r}</button>)}</div>
    </div>
    <div className="chart-wrap">
      <div className="y-axis"><span>{maxValue}</span><span>{Math.round(maxValue * .66)}</span><span>{Math.round(maxValue * .33)}</span><span>0</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Live job throughput chart">
        <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6C8CFF" stopOpacity=".2" /><stop offset="1" stopColor="#6C8CFF" stopOpacity="0" /></linearGradient></defs>
        {[0, 73, 146, 219].map(y => <line key={y} x1="0" y1={y} x2={width} y2={y} className="gridline" />)}
        <polygon points={area} fill="url(#chartFill)" />
        <polyline points={points} className="processed-line" />
        <polyline points={failed} className="failed-line" />
        {points && (() => { const [x, y] = points.split(" ").at(-1)!.split(","); return <><circle cx={x} cy={y} r="8" className="point-pulse" /><circle cx={x} cy={y} r="3.5" className="point" /></>; })()}
      </svg>
      <div className="x-axis"><span>{timeLabel(0)}</span><span>{timeLabel(1 / 3)}</span><span>{timeLabel(2 / 3)}</span><span>Now</span></div>
    </div>
    <div className="chart-legend"><span><i className="line-blue" />Created</span><span><i className="line-red" />Failed</span></div>
  </section>;
}

function QueueVisualization({ queued, active, failed }: { queued: number; active: number; failed: number }) {
  return <section className="card queue-card">
    <div className="card-head">
      <div><div className="section-title">Queue Health</div><div className="section-subtitle">PostgreSQL job and outbox state</div></div>
      <span className="delivery">Transactional outbox</span>
    </div>
    <div className="queue-stats">
      <div><span>Queued</span><strong>{queued}</strong></div>
      <div><span>Running</span><strong>{active}</strong></div>
      <div><span>Failed</span><strong className="danger-text">{failed}</strong></div>
    </div>
    <div className="pipeline">
      {["API", "PostgreSQL", "Outbox", "Workers"].map((label, i) => <div className="pipe-stage" key={label}>
        <div className="stage-icon"><Icon name={i === 0 ? "plus" : i === 1 ? "database" : i === 2 ? "queue" : "server"} /></div>
        <span>{label}</span>{i < 3 && <Icon name="chevron" className="pipe-arrow" />}
      </div>)}
    </div>
    <div className="branch"><span>FAILED</span><div className="branch-line" /><span className="failed-node">RETRY</span><small>Job retry endpoint</small></div>
  </section>;
}

function WorkerFleet({ workers }: { workers: Worker[] }) {
  const activeCount = workers.filter(w => w.status === "ACTIVE").length;
  const staleCount = workers.filter(w => w.status === "STALE").length;
  const total = workers.length;

  return <section className="card worker-card">
    <div className="card-head"><div><div className="section-title">Observed Worker Leases</div><div className="section-subtitle">{activeCount} active · {staleCount} stale</div></div><span className="healthy-summary"><i />From running jobs</span></div>
    <div className="worker-columns"><span>WORKER</span><span>ACTIVE JOBS</span><span>LAST ACTIVITY</span><span>STATE</span></div>
    <div className="worker-list">
      {workers.length === 0 && <div className="empty-state" style={{ padding: '1rem', color: '#666', textAlign: 'center' }}>No active worker leases observed</div>}
      {workers.map(w => <div className="worker-row" key={w.id}>
      <code>{w.id}</code><strong>{w.jobs}</strong><span className="heartbeat">{w.heartbeat}s ago</span><StatusBadge status={w.status} />
    </div>)}</div>
    <Link className="text-action" to="/workers">View worker leases <span>→</span></Link>
  </section>;
}

function RecentJobs({ jobs, onSelect }: { jobs: Job[]; onSelect: (job: Job) => void }) {
  return <section className="card jobs-card">
    <div className="card-head"><div><div className="section-title">Recent Job Activity</div><div className="section-subtitle">Durable state from PostgreSQL</div></div><Link className="text-action" to="/jobs">All jobs <span>→</span></Link></div>
    <div className="table-scroll"><table><thead><tr><th>STATUS</th><th>JOB ID</th><th>TYPE</th><th>WORKER</th><th>ATTEMPT</th><th>CREATED</th><th>DURATION</th></tr></thead>
      <tbody>
        {jobs.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", padding: "1rem", color: "#666" }}>No recent jobs</td></tr>}
        {jobs.map((job, index) => <tr key={`${job.id}-${index}`} onClick={() => onSelect(job)} tabIndex={0}>
        <td><StatusBadge status={job.status} /></td><td><code>{job.id}</code></td><td><code>{job.type}</code></td><td>{job.worker}</td>
        <td>{job.attempt}</td><td>{job.age} sec ago</td><td className="duration">{job.duration}</td>
      </tr>)}</tbody></table></div>
  </section>;
}

function LiveEvents({ events }: { events: EventLog[] }) {
  return <section className="card events-card">
    <div className="card-head">    <div><div className="section-title">Recent Outbox Events</div><div className="section-subtitle">Persisted event publication state</div></div><Link className="icon-btn" to="/queues" aria-label="View queue events"><Icon name="eye" /></Link></div>
    <div className="event-feed">
      {events.length === 0 && <div className="empty-state" style={{ padding: '1rem', color: '#666', textAlign: 'center' }}>Awaiting events...</div>}
      {events.map((e, i) => <div className={`event-item ${i === 0 ? "new-event" : ""}`} key={`${e.time}-${e.type}-${i}`}>
      <span className={`event-dot ${e.tone}`}><Icon name={e.tone === "warning" ? "retry" : e.tone === "success" ? "check" : "event"} size={12} /></span>
      <div><div className="event-meta"><code>{e.type}</code><time>{e.time}</time></div><p>{e.text}</p></div>
    </div>)}</div>
  </section>;
}

function HealthStrip({ health, ready, workers, outbox }: {
  health: HealthResponse | null;
  ready: ReadyResponse | null;
  workers: number;
  outbox: number | null;
}) {
  const items = [
    ["API", health ? "Healthy" : "Unavailable", health ? "Reachable" : "Health check failed"],
    ["PostgreSQL", ready?.checks.database.toUpperCase() ?? "Unknown", "Readiness probe"],
    ["Redis", ready?.checks.redis.toUpperCase() ?? "Unknown", "Readiness probe"],
    ["Workers", `${workers} observed`, "Active job leases"],
    ["Outbox", outbox === null ? "Unknown" : `${outbox} pending`, "Unpublished events"]
  ];
  return <section className="health-strip">{items.map(([name, state, detail]) => <div className="health-unit" key={name}>
    <div><Icon name={name === "PostgreSQL" || name === "Redis" ? "database" : name === "Workers" ? "users" : name === "Outbox" ? "box" : "heart"} /><span>{name}</span></div>
    <strong><i />{state}</strong><small>{detail}</small>
  </div>)}</section>;
}

function toRecentJob(job: ApiJob): Job {
  const age = Math.max(0, Math.floor((Date.now() - new Date(job.created_at).getTime()) / 1000));
  const duration = job.started_at && job.completed_at
    ? `${((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(2)} s`
    : "—";
  return {
    status: job.status,
    id: job.id,
    type: job.type,
    worker: job.locked_by ?? "—",
    attempt: `${job.attempt_count} / ${job.max_attempts}`,
    age,
    duration,
    idempotencyKey: job.idempotency_key
  };
}

function App() {
  const navigate = useNavigate();
  const [queued, setQueued] = useState(0);
  const [active, setActive] = useState(0);
  const [throughput, setThroughput] = useState(0);
  const [success, setSuccess] = useState(0);
  const [failed, setFailed] = useState(0);
  const [averageLatency, setAverageLatency] = useState(0);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<EventLog[]>([]);
  const [chart, setChart] = useState<number[]>([]);
  const [failedChart, setFailedChart] = useState<number[]>([]);
  const [range, setRange] = useState("15m");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [healthData, setHealthData] = useState<HealthResponse | null>(null);
  const [readyData, setReadyData] = useState<ReadyResponse | null>(null);
  const [outboxPending, setOutboxPending] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [quickSearch, setQuickSearch] = useState("");
  const [metricsStreamConnected, setMetricsStreamConnected] = useState(false);

  const fetchRealData = async () => {
    setRefreshing(true);
    const results = await Promise.allSettled([
      getHealth(),
      getReady(),
      getOverview(range)
    ]);
    const [healthResult, readyResult, overviewResult] = results;
    const health = healthResult.status === "fulfilled" ? healthResult.value : null;
    const ready = readyResult.status === "fulfilled" ? readyResult.value : null;
    const overview = overviewResult.status === "fulfilled" ? overviewResult.value : null;
    setHealthData(health);
    setReadyData(ready);
    if (overview) {
      setQueued(overview.counts.QUEUED ?? 0);
      setActive(overview.counts.RUNNING ?? 0);
      setFailed(overview.counts.FAILED ?? 0);
      setJobs(overview.jobs.map(toRecentJob));
      setEvents(overview.events.map((event) => ({
        type: event.event_type,
        text: `job ${event.aggregate_id}`,
        time: new Date(event.created_at).toLocaleTimeString(),
        tone: event.event_type.includes("FAILED") ? "warning" : event.event_type.includes("COMPLETED") ? "success" : "info"
      })));
      const observedAt = Date.now();
      setWorkers(overview.workers.map((worker) => {
        const heartbeat = Math.max(0, Math.floor((observedAt - new Date(worker.lastActivityAt).getTime()) / 1000));
        const status: Worker["status"] = heartbeat > 60 ? "STALE" : "ACTIVE";
        return { id: worker.id, jobs: worker.activeJobs, heartbeat, status };
      }));
      setChart(overview.chart.map((bucket) => bucket.created));
      setFailedChart(overview.chart.map((bucket) => bucket.failed));
      setOutboxPending(overview.unpublishedOutboxEvents);
    }
    const errors = results.flatMap((result) => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "Request failed"]
      : []);
    setLoadError(errors.join("; "));
    setLastUpdated(new Date().toLocaleTimeString());
    setRefreshing(false);
  };

  useEffect(() => {
    void fetchRealData();
  }, [range]);

  useEffect(() => subscribeToRequestMetrics((requestMetrics) => {
    setThroughput(requestMetrics.total);
    setSuccess(requestMetrics.successful);
    setAverageLatency(requestMetrics.averageLatencyMs);
    setMetricsStreamConnected(true);
  }, () => setMetricsStreamConnected(false)), []);

  const degraded = (healthData !== null && healthData.status !== "healthy")
    || (readyData !== null && (readyData.checks.database !== "up" || readyData.checks.redis !== "up"));
  const activeWorkers = workers.filter((worker) => worker.status === "ACTIVE").length;
  const refresh = () => { void fetchRealData(); };

  return <div className="app-shell">
    <main className="main">
      <header className="topbar">
        <div className="crumbs"><span>Overview</span><Icon name="chevron" size={13} /><strong>Command Center</strong></div>
        <form className="global-search" onSubmit={(event) => { event.preventDefault(); navigate(`/jobs?search=${encodeURIComponent(quickSearch)}`); }}>
          <Icon name="search" /><input aria-label="Search jobs" value={quickSearch} onChange={(event) => setQuickSearch(event.target.value)} placeholder="Search jobs, IDs, idempotency keys..." /><kbd>Enter</kbd>
        </form>
        <div className="top-actions"><span className="synced"><Icon name="refresh" />{lastUpdated ? `Updated ${lastUpdated}` : "Connecting…"}</span><Link className="icon-btn" to="/system" aria-label="System status"><Icon name="settings" /></Link></div>
      </header>
      <div className="content">
        <div className="page-header">
          <div><h1>Command Center</h1><p>Real-time overview of fault-tolerant job processing.</p></div>
          <div className="page-actions"><Button icon="refresh" onClick={refresh} loading={refreshing}>Refresh</Button><Link to="/jobs/create" style={{ textDecoration: 'none' }}><Button variant="primary" icon="plus">Create Job</Button></Link></div>
        </div>

        {(degraded || loadError) && <div className="alert-banner"><Icon name="alert" /><div><strong>{degraded ? "System Degraded" : "Some data unavailable"}</strong><span>{loadError || "One or more infrastructure services are unhealthy."}</span></div><small>{degraded ? "WARNING" : "ERROR"}</small></div>}

        <div className="live-strip"><span className="live-tag"><i />LIVE</span><strong>Request metrics {metricsStreamConnected ? "streaming" : "reconnecting"}</strong><span>Counts update as API requests complete</span></div>

        <div className="metrics">
          <MetricCard label="QUEUED JOBS" value={queued} detail="Current database count" icon="queue" />
          <MetricCard label="ACTIVE JOBS" value={active} detail={`${activeWorkers} observed worker leases`} icon="activity" />
          <MetricCard label="API REQUESTS" value={throughput.toLocaleString()} detail="Since API process start" icon="bolt" />
          <MetricCard label="SUCCESSFUL REQS" value={success} detail="Successful HTTP responses" icon="check" tone="success" />
          <MetricCard label="FAILED JOBS" value={failed} detail="Current failed job count" icon="alert" tone="warning" />
          <MetricCard label="AVG API LATENCY" value={`${averageLatency.toFixed(1)} ms`} detail="Since API process start" icon="clock" />
        </div>

        <div className="primary-grid"><ThroughputChart values={chart} failedValues={failedChart} range={range} setRange={setRange} /><QueueVisualization queued={queued} active={active} failed={failed} /></div>
        <div className="secondary-grid"><WorkerFleet workers={workers} /><RecentJobs jobs={jobs} onSelect={setSelectedJob} /><LiveEvents events={events} /></div>
        <HealthStrip health={healthData} ready={readyData} workers={activeWorkers} outbox={outboxPending} />
        <footer><span>JobMesh Control Plane</span><span>PostgreSQL-backed job and outbox data</span><Link to="/system">System operations</Link></footer>
      </div>
    </main>

    {selectedJob && <div className="drawer-layer" onClick={() => setSelectedJob(null)}><aside className="job-drawer" onClick={e => e.stopPropagation()}>
      <div className="drawer-head"><div><span>JOB DETAILS</span><code>{selectedJob.id}</code></div><button className="icon-btn" onClick={() => setSelectedJob(null)}><Icon name="x" /></button></div>
      <StatusBadge status={selectedJob.status} /><div className="detail-list">{[["Type", selectedJob.type], ["Worker", selectedJob.worker], ["Attempt", selectedJob.attempt], ["Created", `${selectedJob.age} sec ago`], ["Duration", selectedJob.duration], ["Idempotency key", selectedJob.idempotencyKey]].map(([k, v]) => <div key={k}><span>{k}</span><code>{v}</code></div>)}</div>
      <div style={{ marginTop: '1rem' }}><Link to={`/jobs/${selectedJob.id}`}><Button variant="primary" onClick={() => setSelectedJob(null)}>View Full Details</Button></Link></div>
    </aside></div>}
  </div>;
}

export default App;
