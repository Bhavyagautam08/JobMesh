import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import "./all-jobs.css";
import { cancelJob, getJobs, retryJob } from "./api/jobs";
import type { Job as ApiJob } from "./api/jobs";

type Status = "QUEUED" | "RUNNING" | "SUCCESS" | "RETRYING" | "FAILED" | "CANCELLED";
type JobRow = {
  id: string;
  type: "calculate_primes" | "process_json" | "cpu_intensive" | "long_running";
  status: Status;
  priority: string;
  attempt: number;
  maxAttempts: number;
  worker?: string;
  scheduled: string;
  created: string;
  duration: string;
  updated: string;
  key: string;
  reason?: string;
};

const types = ["calculate_primes", "process_json", "cpu_intensive", "long_running"];

function toJobRow(job: ApiJob): JobRow {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(job.created_at).getTime()) / 1000));
  const priorityLabels = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
  const duration = job.started_at && job.completed_at
    ? `${((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(2)} s`
    : "—";
  return {
    id: job.id,
    type: job.type as JobRow["type"],
    status: job.status,
    priority: priorityLabels[job.priority] ?? String(job.priority),
    attempt: job.attempt_count,
    maxAttempts: job.max_attempts,
    worker: job.locked_by ?? undefined,
    scheduled: job.scheduled_at ? new Date(job.scheduled_at).toLocaleTimeString() : "—",
    created: new Date(job.created_at).toLocaleString(),
    duration,
    updated: ageSeconds < 5 ? "now" : `${ageSeconds}s ago`,
    key: job.idempotency_key,
    reason: job.error ?? undefined
  };
}


const iconPaths: Record<string, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  jobs: <><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  down: <path d="m6 9 6 6 6-6"/>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  worker: <><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  queue: <><path d="M5 6h14M5 12h9M5 18h6"/><circle cx="18" cy="17" r="3"/></>,
  pulse: <path d="M3 12h4l2-7 4 14 2-7h6"/>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1z"/></>,
};

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{iconPaths[name]}</svg>;
}

function Sidebar() {
  const sections = [
    ["OVERVIEW", [["Command Center", "grid"]]],
    ["JOBS", [["All Jobs", "jobs"], ["Create Job", "plus"], ["Retry Queue", "refresh"], ["Failed Jobs", "info"]]],
    ["INFRASTRUCTURE", [["Workers", "worker"], ["Queue", "queue"], ["Events", "pulse"]]],
    ["OBSERVABILITY", [["Metrics", "pulse"], ["System Health", "info"]]],
    ["SYSTEM", [["Settings", "settings"]]],
  ];
  return <aside className="all-jobs-sidebar">
    <div className="all-jobs-brand"><div className="brand-mark"><span/><span/><span/></div><span>JOBMESH</span></div>
    <nav>{sections.map(([label, items]) => <div className="nav-section" key={label as string}>
      <div className="nav-label">{label as string}</div>
      {(items as string[][]).map(([item, icon]) => {
        const isJobs = item === "All Jobs";
        const isCmd = item === "Command Center";
        const destinations: Record<string, string> = {
          "All Jobs": "/jobs",
          "Create Job": "/jobs/create",
          "Retry Queue": "/jobs?status=QUEUED",
          "Failed Jobs": "/jobs?status=FAILED",
          "Workers": "/workers",
          "Queue": "/queues",
          "Events": "/queues",
          "Metrics": "/system",
          "System Health": "/system",
          "Settings": "/system"
        };
        const to = isCmd ? "/" : destinations[item] ?? "/jobs";
        return <Link to={to} className={`nav-item ${isJobs ? "active" : ""}`} key={item}><Icon name={icon}/><span>{item}</span></Link>;
      })}
    </div>)}</nav>
    <div className="system-card">
      <div className="operational"><span className="health-dot"/>SYSTEMS STATUS</div>
      <Link to="/system" className="health-row"><span>Service health</span><strong>View</strong></Link>
    </div>
  </aside>;
}

function Topbar({ lastSync }: { lastSync: string }) {
  return <header className="topbar">
    <div className="mobile-brand">JM</div>
    <div className="breadcrumb"><span>Jobs</span><Icon name="chevron" size={13}/><b>All Jobs</b></div>
    <div className="global-search"><Icon name="search"/><span>Search jobs, IDs, idempotency keys...</span><kbd>⌘ K</kbd></div>
    <div className="top-meta"><span className="environment">CONTROL PLANE</span>{lastSync && <span className="synced"><i/>{lastSync}</span>}<Link className="icon-btn" aria-label="View queue events" to="/queues"><Icon name="bell"/></Link><Link className="avatar" aria-label="Command Center" to="/">JM</Link></div>
  </header>;
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`status status-${status.toLowerCase()}`}><i/>{status}</span>;
}

function FilterDropdown({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="filter-wrap">
    <button className={`filter-button ${value ? "has-value" : ""}`} onClick={() => setOpen(!open)}>{label}<Icon name="down" size={13}/></button>
    {open && <div className="filter-menu">{options.map(option => <button key={option} onClick={() => { onChange(option); setOpen(false); }}><span>{option}</span>{value === option && <Icon name="check" size={14}/>}</button>)}</div>}
  </div>;
}

function JobId({ job, copy }: { job: JobRow; copy: (value: string) => void }) {
  return <div className="job-id"><button className="id-link" title={job.id}>{job.id.slice(0, 8)}...{job.id.slice(-3)}</button><button className="copy" title="Copy job ID" onClick={(e) => { e.stopPropagation(); copy(job.id); }}><Icon name="copy" size={13}/></button><span className="idempotent" title="This job was created with an Idempotency-Key. Duplicate requests resolve to the same logical job."><Icon name="check" size={10}/></span></div>;
}

function Pagination({ count }: { count: number }) {
  return <div className="pagination">
    <div>Showing <b>{count}</b> loaded job{count === 1 ? "" : "s"} <span className="server-note">· Refresh for the latest records</span></div>
  </div>;
}

function AllJobs() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState(searchParams.get("status") ?? "ALL");
  const [type, setType] = useState("");
  const [worker, setWorker] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [lastSync, setLastSync] = useState("");
  const [sort, setSort] = useState<"default" | "asc" | "desc">("desc");

  const fetchJobs = async () => {
    try {
      if (!jobs.length) setLoading(true);
      const res = await getJobs({ limit: 250 });
      setJobs(res.jobs.map(toJobRow));
      setTotal(res.total);
      setStatusCounts(res.statusCounts);
      setLoadError("");
      setLastSync('Synced just now');
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "Unable to load jobs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchJobs();
  }, []);

  useEffect(() => {
    const requestedStatus = searchParams.get("status");
    setStatus(requestedStatus ?? "ALL");
    setSearch(searchParams.get("search") ?? "");
  }, [searchParams]);

  // Derive unique workers from actual job data
  const workerOptions = useMemo(() => [...new Set(jobs.map(j => j.worker).filter(Boolean))] as string[], [jobs]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => jobs.filter(job =>
    (status === "ALL" || job.status === status) &&
    (!type || job.type === type) &&
    (!worker || job.worker === worker) &&
    (!priority || job.priority === priority) &&
    (!search || `${job.id} ${job.type} ${job.key}`.toLowerCase().includes(search.toLowerCase()))
  ).sort((a, b) => sort === "default" ? 0 : sort === "desc" ? jobs.indexOf(a) - jobs.indexOf(b) : jobs.indexOf(b) - jobs.indexOf(a)), [jobs, status, type, worker, priority, search, sort]);

  const activeFilters = [["Status", status === "ALL" ? "" : status], ["Type", type], ["Worker", worker], ["Priority", priority]].filter(([, v]) => v);
  const clear = () => { setStatus("ALL"); setType(""); setWorker(""); setPriority(""); setSearch(""); };
  const copy = (value: string) => { navigator.clipboard?.writeText(value); setToast("Job ID copied"); };
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const retrySelected = async () => {
    const ids = [...selected].filter((id) => jobs.some((job) => job.id === id && job.status === "FAILED"));
    if (!ids.length) return;
    setActionBusy(true);
    try {
      await Promise.all(ids.map(retryJob));
      setSelected(new Set());
      setConfirm(false);
      setToast(`${ids.length} retry request${ids.length === 1 ? "" : "s"} accepted`);
      await fetchJobs();
    } catch (actionError) {
      setLoadError(actionError instanceof Error ? actionError.message : "Unable to retry selected jobs");
    } finally {
      setActionBusy(false);
    }
  };
  const cancelSelected = async () => {
    const ids = [...selected].filter((id) => jobs.some((job) => job.id === id && job.status === "QUEUED"));
    if (!ids.length) return;
    setActionBusy(true);
    try {
      await Promise.all(ids.map(cancelJob));
      setSelected(new Set());
      setToast(`${ids.length} queued job${ids.length === 1 ? "" : "s"} cancelled`);
      await fetchJobs();
    } catch (actionError) {
      setLoadError(actionError instanceof Error ? actionError.message : "Unable to cancel selected jobs");
    } finally {
      setActionBusy(false);
    }
  };

  const activeWorkers = jobs.filter(j => j.status === 'RUNNING').length;

  return <div className="all-jobs-shell">
    <Sidebar/><div className="workspace"><Topbar lastSync={lastSync}/>
    <main className="content">
      <div className="page-header">
        <div><div className="eyebrow"><span className="live-dot"/>LIVE {activeWorkers > 0 && <span>{activeWorkers} job{activeWorkers !== 1 ? 's' : ''} running</span>}</div><h1>Jobs</h1><p>Inspect, filter and manage multi-process job execution.</p></div>
        <div className="header-actions"><button className="secondary" onClick={() => void fetchJobs()} disabled={loading}><Icon name="refresh"/>Refresh</button><button className="primary" onClick={() => navigate("/jobs/create")}><Icon name="plus"/>Create Job</button></div>
      </div>
      {loadError && <div className="panel" role="alert" style={{ padding: "1rem", marginBottom: "1rem", color: "var(--red)" }}>{loadError}</div>}
      {loading && !jobs.length && <div className="empty">Loading jobs…</div>}
      <div className="summary-line">
        <span><b>{total}</b> total jobs</span>
        <span><i className="q"/>{statusCounts.QUEUED ?? 0} queued</span>
        <span><i className="r"/>{statusCounts.RUNNING ?? 0} running</span>
        <span><i className="f"/>{statusCounts.FAILED ?? 0} failed</span>
        <span><i className="s"/>{statusCounts.SUCCESS ?? 0} completed</span>
      </div>

      <section className="status-summary">
        {[
          ["ALL", total],
          ["QUEUED", statusCounts.QUEUED ?? 0],
          ["RUNNING", statusCounts.RUNNING ?? 0],
          ["SUCCESS", statusCounts.SUCCESS ?? 0],
          ["FAILED", statusCounts.FAILED ?? 0]
        ].map(([name, count]) => <button key={name as string} onClick={() => setStatus(name as string)} className={status === name ? "selected" : ""}><span>{name as string}</span><b>{count as number}</b></button>)}
      </section>

      <section className="table-shell">
        {selected.size ? <div className="bulk-bar"><div><b>{selected.size} jobs selected</b><span>{[...selected].filter(id => jobs.find(j => j.id === id)?.status === "FAILED").length} failed · {[...selected].filter(id => jobs.find(j => j.id === id)?.status === "QUEUED").length} queued</span></div><div><button disabled={actionBusy} onClick={() => setConfirm(true)}><Icon name="refresh"/>Retry failed</button><button disabled={actionBusy} onClick={() => void cancelSelected()}><span>×</span>Cancel queued</button><button className="clear-selection" onClick={() => setSelected(new Set())}>Clear selection</button></div></div> :
        <div className="filters">
          <label className="search-field"><Icon name="search"/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by Job ID, type, idempotency key..."/><kbd>/</kbd></label>
          <div className="filter-list">
            <FilterDropdown label="Status" value={status === "ALL" ? "" : status} options={["ALL","QUEUED","RUNNING","SUCCESS","FAILED","CANCELLED"]} onChange={setStatus}/>
            <FilterDropdown label="Type" value={type} options={types} onChange={setType}/>
            <FilterDropdown label="Worker" value={worker} options={workerOptions.length ? workerOptions : []} onChange={setWorker}/>
            <FilterDropdown label="Priority" value={priority} options={["LOW","NORMAL","HIGH","CRITICAL"]} onChange={setPriority}/>
            <FilterDropdown label="Created time" options={["Last 5 minutes","Last hour","Last 24 hours","Last 7 days","Custom"]} onChange={() => setToast("Created time filter applied")}/>
            <FilterDropdown label="Attempt count" options={["1","2","3","3+"]} onChange={() => setToast("Attempt filter applied")}/>
            <button className="more-filter"><Icon name="filter"/>More filters</button>
          </div>
          <div className="view-controls"><button onClick={clear}>Clear filters</button><div><button className="active">Table</button><button>Compact</button></div></div>
        </div>}
        {!!activeFilters.length && <div className="chips">{activeFilters.map(([name, value]) => <button key={name} onClick={() => name === "Status" ? setStatus("ALL") : name === "Type" ? setType("") : name === "Worker" ? setWorker("") : setPriority("")}><span>{name}:</span> {value} ×</button>)}<button className="clear-all" onClick={clear}>Clear all</button></div>}

        <div className="table-scroll">
          <table>
            <thead><tr>
              <th className="check-cell"><input type="checkbox" checked={filtered.length > 0 && filtered.every(j => selected.has(j.id))} onChange={() => filtered.every(j => selected.has(j.id)) ? setSelected(new Set()) : setSelected(new Set(filtered.map(j => j.id)))}/></th>
              <th>STATUS</th><th>JOB ID</th><th>TYPE</th><th>PRIORITY</th><th title="Attempt count: Number of execution attempts made by workers.">ATTEMPT</th><th title="Worker process currently responsible for execution.">WORKER</th><th title="Time at which the job becomes eligible for execution.">SCHEDULED</th>
              <th><button className="sort" onClick={() => setSort(sort === "desc" ? "asc" : sort === "asc" ? "default" : "desc")}>CREATED {sort === "desc" ? "↓" : sort === "asc" ? "↑" : ""}</button></th><th>DURATION</th><th>UPDATED</th><th/>
            </tr></thead>
            <tbody>{filtered.map(job => <tr key={job.id} className={job.updated === "now" ? "just-updated" : ""} onClick={() => navigate(`/jobs/${job.id}`)} style={{ cursor: 'pointer' }}>
              <td className="check-cell"><input type="checkbox" checked={selected.has(job.id)} onChange={() => toggle(job.id)} onClick={e => e.stopPropagation()}/></td>
              <td><StatusBadge status={job.status}/>{job.reason && <small className="failure-reason" title={`${job.reason}. No retries remaining.`}>{job.reason}</small>}</td>
              <td><JobId job={job} copy={copy}/><small className="key-preview">{job.key}</small></td>
              <td><span className="job-type">{job.type}</span></td>
              <td><span className={`priority priority-${job.priority.toLowerCase()}`}>{job.priority}</span></td>
              <td><span className="attempt">{job.attempt ? `${job.attempt} / ${job.maxAttempts}` : "—"}</span></td>
              <td>{job.worker ? <span className="worker"><i/>{job.worker}</span> : <span className="muted">—</span>}</td>
              <td><span className={job.scheduled !== "—" ? "scheduled" : "muted"}>{job.scheduled !== "—" && <Icon name="clock" size={13}/>} {job.scheduled}</span></td>
              <td className="mono">{job.created}</td><td className="mono">{job.duration}</td><td className="mono">{job.updated}</td>
              <td className="row-end"><Icon name="arrow" size={15}/><button onClick={(e) => {e.stopPropagation(); setMenu(menu === job.id ? null : job.id);}}><Icon name="more"/></button>
                {menu === job.id && <div className="action-menu" onClick={e => e.stopPropagation()}><button onClick={() => navigate(`/jobs/${job.id}`)}>View details</button>{job.worker && <button onClick={() => navigate(`/workers?worker=${encodeURIComponent(job.worker!)}`)}>View worker</button>}{job.status === "FAILED" && <button className="retry" onClick={() => { setSelected(new Set([job.id])); setConfirm(true); setMenu(null); }}>Retry job</button>}{job.status === "QUEUED" && <button onClick={async () => { try { await cancelJob(job.id); await fetchJobs(); setToast("Queued job cancelled"); } catch (actionError) { setLoadError(actionError instanceof Error ? actionError.message : "Unable to cancel job"); } setMenu(null); }}>Cancel job</button>}<button onClick={() => { navigator.clipboard?.writeText(job.id); setToast('Job ID copied'); setMenu(null); }}>Copy job ID</button></div>}
              </td>
            </tr>)}</tbody>
          </table>
          {!filtered.length && <div className="empty"><div className="empty-icon"><Icon name="search" size={22}/></div><b>No jobs match your filters.</b><span>Try adjusting your search or clearing active filters.</span><button className="secondary" onClick={clear}>Clear filters</button></div>}
        </div>
        <div className="mobile-jobs">{filtered.map(job => <button className="job-card" key={job.id} onClick={() => navigate(`/jobs/${job.id}`)}><div><StatusBadge status={job.status}/><Icon name="chevron"/></div><JobId job={job} copy={copy}/><strong>{job.type}</strong><div className="card-meta"><span>Attempt {job.attempt || "—"} / {job.maxAttempts}</span><span>{job.worker || "Unassigned"}</span><span>{job.updated}</span></div></button>)}</div>
        <Pagination count={filtered.length}/>
      </section>
      <div className="architecture-note"><span>PostgreSQL <b>SOURCE OF TRUTH</b></span><i/><span>Redis Streams <b>QUEUE / COORDINATION</b></span><i/><span>Worker and queue views are linked in the sidebar</span></div>
    </main></div>

    {toast && <div className="toast"><span className="toast-icon"><Icon name="check"/></span><div><b>{toast.split(" · ")[0]}</b>{toast.includes(" · ") && <span>{toast.split(" · ")[1]}</span>}</div></div>}
    {confirm && <div className="overlay center"><div className="modal"><div className="modal-icon"><Icon name="refresh"/></div><h2>Retry selected jobs?</h2><p>Failed jobs will be scheduled through the backend. The retry limit is extended by one attempt for each manual retry.</p><div className="modal-actions"><button className="secondary" onClick={() => setConfirm(false)}>Cancel</button><button className="primary" disabled={actionBusy} onClick={() => void retrySelected()}>{actionBusy ? "Submitting…" : "Retry jobs"}</button></div></div></div>}
  </div>;
}

export default AllJobs;
