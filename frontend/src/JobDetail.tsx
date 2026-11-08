import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import "./job-detail.css";

type IconName =
  | "grid" | "jobs" | "workers" | "queue" | "metrics" | "system"
  | "search" | "bell" | "chevron" | "copy" | "retry" | "replay"
  | "cancel" | "more" | "download" | "expand" | "collapse" | "external" | "check";

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    jobs: <><path d="M8 4h11a2 2 0 0 1 2 2v13H8z" /><path d="M3 8h5v11H3zM11 8h6M11 12h6M11 16h4" /></>,
    workers: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" /></>,
    queue: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="7" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
    metrics: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></>,
    system: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63h.01A1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9v.01A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15z" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    retry: <><path d="M20 6v5h-5" /><path d="M19 11a7 7 0 1 0 .1 4" /></>,
    replay: <><path d="m8 5 10 7-10 7z" /></>,
    cancel: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M4 19h16" /></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></>,
    collapse: <><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" /></>,
    external: <><path d="M14 3h7v7M10 14 21 3" /><path d="M18 13v7H4V6h7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const navItems: { name: string; icon: IconName; to: string }[] = [
  { name: "Command Center", icon: "grid", to: "/" },
  { name: "Jobs", icon: "jobs", to: "/jobs" },
  { name: "Workers", icon: "workers", to: "/workers" },
  { name: "Queues", icon: "queue", to: "/queues" },
  { name: "Metrics", icon: "metrics", to: "/system" },
  { name: "System", icon: "system", to: "/system" },
];

function SectionHeader({ title, meta, actions }: { title: string; meta?: string; actions?: React.ReactNode }) {
  return <div className="section-header"><div><div className="section-title">{title}</div>{meta && <div className="section-meta">{meta}</div>}</div>{actions && <div className="section-actions">{actions}</div>}</div>;
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (value) navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  };
  return <button className="copy-button" onClick={copy} disabled={!value}><Icon name={copied ? "check" : "copy"} size={13} /><span>{copied ? "Copied" : label ?? value}</span></button>;
}

import { cancelJob, getJob, retryJob } from "./api/jobs";
import type { Job, JobAttempt, JobEvent } from "./api/jobs";

export default function JobDetail() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [quickSearch, setQuickSearch] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [attempts, setAttempts] = useState<JobAttempt[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const fetchJobDetails = async () => {
    if (!id) return;
    try {
      const res = await getJob(id);
      setJob(res.job);
      setAttempts(res.attempts);
      setEvents(res.events);
      setError("");
      return res.job.status === "SUCCESS" || res.job.status === "FAILED" || res.job.status === "CANCELLED";
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load this job");
      return true;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const poll = async () => {
      const done = await fetchJobDetails();
      if (!cancelled && !done) timer = window.setTimeout(() => void poll(), 3000);
    };
    setLoading(true);
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id, pollVersion]);

  const performJobAction = async (action: "retry" | "cancel") => {
    if (!job) return;
    setActionBusy(true);
    try {
      const response = action === "retry" ? await retryJob(job.id) : await cancelJob(job.id);
      setJob(response.job);
      setToast(action === "retry" ? "Retry scheduled" : "Queued job cancelled");
      setError("");
      setPollVersion((version) => version + 1);
      await fetchJobDetails();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Unable to ${action} job`);
    } finally {
      setActionBusy(false);
    }
  };

  // Display ID — truncated for header, full for copy
  const formatDate = (iso?: string | null) => iso ? new Date(iso).toLocaleString() : "—";
  const duration = job?.started_at && job.completed_at
    ? `${((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(2)}s`
    : "—";

  const summary: [string, string][] = job ? [
    ["Job ID", job.id],
    ["Job Type", job.type],
    ["Status", job.status],
    ["Priority", String(job.priority)],
    ["Idempotency Key", job.idempotency_key || "—"],
    ["Attempt Count", `${job.attempt_count} / ${job.max_attempts}`],
    ["Current Worker", job.locked_by || "—"],
    ["Created At", formatDate(job.created_at)],
    ["Scheduled At", formatDate(job.scheduled_at)],
    ["Started At", formatDate(job.started_at)],
    ["Completed At", formatDate(job.completed_at)],
    ["Updated At", formatDate(job.updated_at)],
    ["Duration", duration],
    ["Version", String(job.version)]
  ] : [
    ["Job ID", id ?? "—"],
    ["Job Type", "—"],
    ["Status", "—"],
    ["Priority", "—"],
    ["Idempotency Key", "—"],
    ["Attempt Count", "—"],
    ["Current Worker", "—"],
    ["Created At", "—"],
    ["Scheduled At", "—"],
    ["Started At", "—"],
    ["Completed At", "—"],
    ["Updated At", "—"],
    ["Duration", "—"],
    ["Version", "—"]
  ];

  const timeline: { label: string; time: string; meta: string; state: string }[] = [];
  if (job) {
    timeline.push({ label: "Created", time: formatDate(job.created_at), meta: "Persisted to PostgreSQL", state: "success" });
    if (job.scheduled_at) timeline.push({ label: "Queued", time: formatDate(job.scheduled_at), meta: "Eligible for execution", state: "success" });
    for (const attemptRecord of attempts) {
      timeline.push({
        label: `Attempt ${attemptRecord.attempt_number}`,
        time: formatDate(attemptRecord.started_at),
        meta: attemptRecord.status,
        state: attemptRecord.status === "FAILED" ? "failed" : attemptRecord.status === "RUNNING" ? "active" : "success"
      });
      if (attemptRecord.completed_at) {
        timeline.push({
          label: attemptRecord.status === "SUCCESS" ? "Success" : "Failed",
          time: formatDate(attemptRecord.completed_at),
          meta: attemptRecord.error || attemptRecord.status,
          state: attemptRecord.status === "FAILED" ? "failed" : "success"
        });
      }
    }
    if (job.status === "CANCELLED" && job.completed_at) {
      timeline.push({ label: "Cancelled", time: formatDate(job.completed_at), meta: "Cancelled while queued", state: "failed" });
    }
  }

  const [timelineSelected, setTimelineSelected] = useState(0);

  const payloadText = job ? JSON.stringify(job.payload, null, 2) : "";
  const resultText = job?.result == null ? "" : JSON.stringify(job.result, null, 2);

  return <div className="jd-shell">
    <aside className="jd-sidebar">
      <div className="jd-brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>JobMesh</strong><small>MULTI-PROCESS RUNTIME</small></div></div>
      <nav>
        <div className="nav-label">CONTROL PLANE</div>
        {navItems.map((item) => <Link to={item.to} key={item.name} className={`nav-item ${item.name === "Jobs" ? "active" : ""}`}>
          <Icon name={item.icon} size={17} /><span>{item.name}</span>
        </Link>)}
      </nav>
      <div className="sidebar-foot">
        <div className="cluster-status"><span className="status-dot" /><div><strong>—</strong><small>Status pending</small></div></div>
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
          <Link className="icon-button notification" aria-label="View queue events" to="/queues"><Icon name="bell" /><span /></Link>
          <Link className="profile" to="/"><span>JM</span><div><strong>JobMesh</strong><small>Command Center</small></div><Icon name="chevron" size={12} /></Link>
        </div>
      </header>

      <main>
        <div className="breadcrumb">
          <Link to="/queues">Queue</Link><Icon name="chevron" size={12} />
          <span>Job Details</span>
        </div>
        {error && <div className="panel" role="alert" style={{ padding: "1rem", marginBottom: "1rem", color: "var(--red)" }}>{error}</div>}
        <div className="page-header">
          <div className="page-heading">
            <div className="eyebrow">JOB DETAILS / EXECUTION TRACE</div>
            <div className="title-row">
              <h1>Job Details</h1>
              {job && <span className={`badge ${job.status.toLowerCase()}`}><span className="status-dot" />{job.status}</span>}
            </div>
            <div className="subtitle"><code>{id ?? "—"}</code><CopyButton value={id ?? ""} label="Copy Job ID" /></div>
          </div>
          <div className="header-controls">
            <div className="action-group">
              {job?.status === "FAILED" && <button className="button" disabled={actionBusy} onClick={() => void performJobAction("retry")}><Icon name="retry" />Retry Job</button>}
              {job?.status === "QUEUED" && <button className="button danger" disabled={actionBusy} onClick={() => void performJobAction("cancel")}><Icon name="cancel" />Cancel Job</button>}
            </div>
          </div>
        </div>
        {loading && !job && <div className="panel" role="status" style={{ padding: "1.5rem" }}>Loading job details…</div>}

        <div className="page-grid">
          <div className="primary-column">
            {/* Job Summary */}
            <section className="panel summary-panel">
              <SectionHeader title="Job Summary" meta="Durable job state from PostgreSQL" actions={<span className="synced"><span className="status-dot" />AWAITING DATA</span>} />
              <div className="summary-grid">
                {summary.map(([key, value], i) => <div className={`summary-item ${i === 0 || i === 4 ? "wide" : ""}`} key={key}>
                  <span>{key}</span>
                  <strong className={`${key === "Status" ? "status-text" : ""} ${key.includes("Worker") || key === "Idempotency Key" ? "link" : ""}`}
                    onClick={() => key === "Idempotency Key" ? setDuplicateOpen(true) : undefined}>{value}</strong>
                </div>)}
              </div>
            </section>

            {/* Execution Lifecycle */}
            <section className="panel timeline-panel">
              <SectionHeader title="Execution Lifecycle" meta="End-to-end delivery and execution trace" actions={<><span className="legend success-key">Success</span><span className="legend fail-key">Failed</span><span className="legend retry-key">Retry</span></>} />
              {timeline.length === 0
                ? <div className="empty-timeline">No execution events yet — awaiting job data.</div>
                : <>
                  <div className="timeline-scroll"><div className="timeline">
                    {timeline.map((stage, i) => <button className={`timeline-node ${stage.state} ${timelineSelected === i ? "selected" : ""}`} key={`${stage.label}-${i}`} onClick={() => setTimelineSelected(i)}>
                      <span className="node-index">{stage.state === "success" ? <Icon name="check" size={11} /> : i + 1}</span>
                      <span className="node-label">{stage.label}</span><span className="node-time">{stage.time}</span><span className="node-meta">{stage.meta}</span>
                    </button>)}
                  </div></div>
                  <div className="timeline-detail">
                    <div><span>SELECTED EVENT</span><strong>{timeline[timelineSelected]?.label ?? "—"}</strong></div>
                    <div><span>EVENT ID</span><code>—</code></div>
                    <div><span>PROCESS</span><code>{timeline[timelineSelected]?.meta.split(" · ")[0] ?? "—"}</code></div>
                    <div><span>STATE TRANSITION</span><code>— → {timeline[timelineSelected]?.state.toUpperCase() ?? "—"}</code></div>
                    <button>View raw metadata <Icon name="external" size={12} /></button>
                  </div>
                </>}
            </section>

            <section className="panel">
              <SectionHeader title="Execution Attempts" meta={`${attempts.length} recorded attempt${attempts.length === 1 ? "" : "s"}`} />
              <div className="table-wrap"><table>
                <thead><tr><th>ATTEMPT</th><th>WORKER</th><th>STARTED</th><th>COMPLETED</th><th>DURATION</th><th>STATUS</th><th>ERROR</th><th></th></tr></thead>
                <tbody>
                  {attempts.length === 0 && <tr><td colSpan={8} className="empty-row">{loading ? "Loading attempts…" : "No execution attempts recorded."}</td></tr>}
                  {attempts.map((record) => {
                    const elapsed = record.completed_at
                      ? `${((new Date(record.completed_at).getTime() - new Date(record.started_at).getTime()) / 1000).toFixed(2)}s`
                      : "—";
                    const worker = job?.status === "RUNNING" && record.attempt_number === job.attempt_count ? job.locked_by || "—" : "—";
                    return <tr key={record.id}>
                      <td>{record.attempt_number}</td><td>{worker}</td><td>{formatDate(record.started_at)}</td>
                      <td>{formatDate(record.completed_at)}</td><td>{elapsed}</td><td>{record.status}</td><td colSpan={2}>{record.error || "—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table></div>
            </section>

            <div className="split-grid result-error">
              <section className="panel">
                <SectionHeader title="Payload" meta="Submitted JSON" actions={<div className="compact-actions">
                  <CopyButton value={payloadText} label="Copy JSON" />
                </div>} />
                <pre className="json-view"><code>{job ? payloadText : loading ? "Loading payload…" : "Payload unavailable."}</code></pre>
              </section>
              <section className="panel">
                <SectionHeader title="Result" meta={job?.status === "SUCCESS" ? "Execution output" : "Available after successful execution"} actions={<div className="compact-actions">
                  <CopyButton value={resultText} label="Copy JSON" />
                </div>} />
                <pre className="json-view"><code>{resultText || (job?.status === "SUCCESS" ? "No result was returned." : "Result not available yet.")}</code></pre>
              </section>
            </div>

            {job?.error && <section className="panel failure-panel">
              <SectionHeader title="Execution Error" meta="Latest failure" actions={<span className="badge failed">{job.status}</span>} />
              <div className="failure-message"><strong>Job execution failed.</strong><code>{job.error}</code></div>
              <div className="decision-grid"><div><span>ATTEMPT</span><strong>{job.attempt_count} / {job.max_attempts}</strong></div>
                <div><span>RETRY STATE</span><strong>{job.status === "QUEUED" ? "WAITING FOR RETRY" : "NOT SCHEDULED"}</strong></div>
                <div><span>NEXT EXECUTION</span><strong>{job.status === "QUEUED" ? formatDate(job.scheduled_at) : "—"}</strong></div></div>
            </section>}

            {/* Idempotency / Redis Stream / PostgreSQL State */}
            <div className="triple-grid">
              <section className="panel compact-panel">
                <SectionHeader title="Idempotency" meta="Request deduplication" />
                <button className="identity-key" onClick={() => setDuplicateOpen(!duplicateOpen)}><code>{job?.idempotency_key ?? "—"}</code><Icon name="chevron" size={13} /></button>
                <dl>
                  <div><dt>State</dt><dd>{job ? "REGISTERED" : "—"}</dd></div>
                  <div><dt>Created</dt><dd>{formatDate(job?.created_at)}</dd></div>
                  <div><dt>Resolved Job</dt><dd>{job?.id ?? "—"}</dd></div>
                </dl>
                {duplicateOpen && <div className="inline-note">The key is unique in PostgreSQL and prevents duplicate job creation.</div>}
              </section>
              <section className="panel compact-panel">
                <SectionHeader title="Redis Stream" meta="Asynchronous delivery" />
                <dl>
                  <div><dt>Stream</dt><dd>job-events</dd></div>
                  <div><dt>Consumer Group</dt><dd>job-workers</dd></div>
                  <div><dt>Consumer</dt><dd>{job?.locked_by ?? "—"}</dd></div>
                  <div><dt>Message ID</dt><dd>Not exposed</dd></div>
                  <div><dt>Delivery Count</dt><dd>Not exposed</dd></div>
                </dl>
              </section>
              <section className="panel compact-panel">
                <SectionHeader title="PostgreSQL State" meta="Durable source of truth" />
                <div className="db-state"><span className="status-dot" /><strong>{job ? "PERSISTED" : "—"}</strong></div>
                <dl>
                  <div><dt>Row Version</dt><dd>{job?.version ?? "—"}</dd></div>
                  <div><dt>Locked By</dt><dd>{job?.locked_by ?? "—"}</dd></div>
                  <div><dt>Lock State</dt><dd>{job?.locked_at ? "LEASED" : "UNLOCKED"}</dd></div>
                  <div><dt>Last Updated</dt><dd>{formatDate(job?.updated_at)}</dd></div>
                </dl>
              </section>
            </div>

            <section className="panel event-log">
              <SectionHeader title="Event Log" meta={`${events.length} persisted outbox events`} />
              <div className="logs">
                {events.length === 0
                  ? <div className="empty-timeline">{loading ? "Loading events…" : "No outbox events recorded for this job."}</div>
                  : events.map((event) => <div className="log-row" key={event.id}>
                    <time>{formatDate(event.created_at)}</time>
                    <span className={`level ${event.published ? "info" : "warn"}`}>{event.published ? "PUBLISHED" : "PENDING"}</span>
                    <span className="source">OUTBOX</span><p>{event.event_type}</p>
                  </div>)}
              </div>
            </section>
          </div>

          {/* Right diagnostics panel */}
          <aside className="diagnostics">
            <div className="diagnostic-title"><span>JOB DIAGNOSTICS</span><button><Icon name="more" /></button></div>
            <div className="health-block"><span>JOB STATUS</span><strong><span className="status-dot" />{job?.status ?? "—"}</strong><small>{loading ? "Refreshing from PostgreSQL" : `Version ${job?.version ?? "—"}`}</small></div>
            <div className="diagnostic-list">
              <div><span>DELIVERY SEMANTICS</span><strong>At-least-once</strong><small>Duplicate delivery possible</small></div>
              <div><span>EXECUTION</span><strong>{job?.status ?? "—"}</strong><small>{job?.started_at ? `Started ${formatDate(job.started_at)}` : "Not started"}</small></div>
              <div><span>DATABASE</span><strong>PostgreSQL</strong><small>Durable source of truth</small></div>
              <div><span>QUEUE</span><strong>Redis Streams</strong><small>Async event delivery</small></div>
              <div><span>WORKER</span><strong>{job?.locked_by ?? "—"}</strong><small>{job?.locked_at ? `Lease started ${formatDate(job.locked_at)}` : "No active worker lease"}</small></div>
              <div><span>RETRY POLICY</span><strong>Automatic retries</strong><small>{job ? `${job.attempt_count} / ${job.max_attempts} attempts` : "—"}</small></div>
            </div>
            <div className="architecture-note"><span>DELIVERY GUARANTEE</span><p>Transactional outbox ensures events are published after the job transaction commits. Workers may receive duplicates; idempotency keeps execution safe.</p><Link to="/system">View system health <Icon name="external" size={12} /></Link></div>
          </aside>
        </div>
      </main>
    </div>

    {toast && <div className="toast"><Icon name="check" size={14} />{toast}</div>}
  </div>;
}
