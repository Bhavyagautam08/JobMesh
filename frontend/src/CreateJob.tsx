import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createJob } from "./api/jobs";
import "./job-detail.css"; // Reuse job detail styling since it's the exact same theme

type IconName = "grid" | "jobs" | "workers" | "queue" | "metrics" | "system" | "search" | "bell" | "chevron" | "check" | "info";

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
    check: <path d="m5 12 4 4L19 6" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const navItems = [
  { name: "Command Center", icon: "grid", to: "/" },
  { name: "Jobs", icon: "jobs", to: "/jobs" },
  { name: "Workers", icon: "workers", to: "/workers" },
  { name: "Queues", icon: "queue", to: "/queues" },
  { name: "Metrics", icon: "metrics", to: "/system" },
  { name: "System", icon: "system", to: "/system" },
] as const;

export default function CreateJob() {
  const navigate = useNavigate();
  const [type, setType] = useState("calculate_primes");
  const [payload, setPayload] = useState('{\n  "limit": 10000\n}');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(crypto.randomUUID());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successId, setSuccessId] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessId("");

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (e) {
      setError("Invalid JSON payload. Expected property name...");
      return;
    }

    if (!idempotencyKey) {
      setError("Idempotency key is required.");
      return;
    }

    setLoading(true);
    try {
      const res = await createJob(type, parsedPayload, idempotencyKey);
      setSuccessId(res.job.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to create job.");
    } finally {
      setLoading(false);
    }
  };

  return <div className="jd-shell">
    <aside className="jd-sidebar">
      <div className="jd-brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>JobMesh</strong><small>MULTI-PROCESS RUNTIME</small></div></div>
      <nav>
        <div className="nav-label">CONTROL PLANE</div>
        {navItems.map((item) => <Link to={item.to} key={item.name} className={`nav-item ${item.name === "Jobs" ? "active" : ""}`}>
          <Icon name={item.icon as IconName} size={17} /><span>{item.name}</span>
        </Link>)}
      </nav>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="environment"><span className="status-dot" />CONTROL PLANE</div>
        <div className="top-actions">
          <button className="profile"><span>JM</span><div><strong>JobMesh</strong><small>Platform</small></div><Icon name="chevron" size={12} /></button>
        </div>
      </header>

      <main style={{ maxWidth: '1000px', margin: '0 auto', padding: '2rem' }}>
        <div className="breadcrumb">
          <Link to="/jobs">Jobs</Link><Icon name="chevron" size={12} />
          <span>Create Job</span>
        </div>
        <div className="page-header" style={{ marginBottom: '2rem' }}>
          <div className="page-heading">
            <div className="title-row">
              <h1>Create Job</h1>
            </div>
            <div className="subtitle" style={{ fontSize: '1rem', color: '#888' }}>Submit a new job to the fault-tolerant job queue.</div>
          </div>
        </div>

        {successId ? (
          <div className="panel" style={{ padding: '2rem', textAlign: 'center' }}>
            <h2>Job Created</h2>
            <div style={{ margin: '1rem 0' }}>Job ID: <code>{successId}</code> <button className="copy-button" onClick={() => navigator.clipboard.writeText(successId)}><Icon name="check" size={13} /> Copy</button></div>
            <div>Status: <span className="badge pending"><span className="status-dot" />QUEUED</span></div>
            <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button className="button" onClick={() => { setSuccessId(""); setIdempotencyKey(crypto.randomUUID()); }}>Create Another</button>
              <button className="button primary" onClick={() => navigate(`/jobs/${successId}`)}>View Job</button>
            </div>
          </div>
        ) : (
          <div className="page-grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <div className="primary-column">
              <form onSubmit={handleCreate} className="panel summary-panel" style={{ padding: '2rem' }}>
                {error && <div style={{ background: 'rgba(255,50,50,0.1)', color: '#ff4444', padding: '1rem', borderRadius: '4px', marginBottom: '1.5rem', border: '1px solid rgba(255,50,50,0.2)' }}>{error}</div>}

                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Job Type</label>
                  <select value={type} onChange={e => setType(e.target.value)} style={{ width: '100%', padding: '0.75rem', background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px' }}>
                    <option value="calculate_primes">calculate_primes - CPU-bound prime number calculation</option>
                    <option value="process_json">process_json - JSON processing workload</option>
                    <option value="cpu_intensive">cpu_intensive - Synthetic CPU-intensive workload</option>
                    <option value="long_running">long_running - Long-running worker workload</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Job Payload</label>
                  <div style={{ fontSize: '0.85rem', color: '#888', marginBottom: '0.5rem' }}>Provide the JSON data required by the selected job handler.</div>
                  <textarea
                    value={payload}
                    onChange={e => setPayload(e.target.value)}
                    rows={8}
                    style={{ width: '100%', padding: '1rem', background: '#0a0a0c', border: '1px solid var(--border)', color: '#00ffcc', fontFamily: 'monospace', borderRadius: '4px' }}
                  />
                  {payload && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: (() => { try { JSON.parse(payload); return '#00cc66'; } catch { return '#ff4444'; } })() }}>
                      {(() => { try { JSON.parse(payload); return '✓ Valid JSON'; } catch { return 'Invalid JSON'; } })()}
                    </div>
                  )}
                </div>

                <div style={{ marginBottom: '2rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Idempotency Key <span style={{ color: '#ff4444', fontSize: '0.8rem' }}>Required</span></label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      value={idempotencyKey}
                      onChange={e => setIdempotencyKey(e.target.value)}
                      style={{ flex: 1, padding: '0.75rem', background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', fontFamily: 'monospace' }}
                      required
                    />
                    <button type="button" className="button" onClick={() => setIdempotencyKey(crypto.randomUUID())}>Generate</button>
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>Used to prevent duplicate job creation when the same request is retried.</div>
                </div>

                <div style={{ display: 'flex', gap: '1rem' }}>
                  <button type="submit" className="button primary" disabled={loading} style={{ padding: '0.75rem 2rem' }}>{loading ? "Creating Job..." : "Create Job"}</button>
                  <button type="button" className="button" onClick={() => navigate('/jobs')} style={{ padding: '0.75rem 2rem' }}>Cancel</button>
                </div>
              </form>
            </div>

            <aside className="diagnostics">
              <div className="panel compact-panel" style={{ marginBottom: '1.5rem' }}>
                <div className="section-header"><div><div className="section-title">Job Execution</div></div></div>
                <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center', color: '#888', fontSize: '0.9rem' }}>
                  <div>Create Job</div><div>↓</div>
                  <div>PostgreSQL</div><div>↓</div>
                  <div>Outbox</div><div>↓</div>
                  <div>Redis Stream</div><div>↓</div>
                  <div>Worker</div><div>↓</div>
                  <div>Execution</div>
                </div>
              </div>
              <div className="panel compact-panel">
                <div className="section-header"><div><div className="section-title">Reliability</div></div></div>
                <div className="diagnostic-list" style={{ padding: '1rem' }}>
                  <div style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}><span>Idempotent</span><small>Duplicate requests are safely handled.</small></div>
                  <div style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}><span>Retryable</span><small>Failed jobs can be retried automatically.</small></div>
                  <div style={{ padding: '0.5rem 0' }}><span>Fault Tolerant</span><small>Worker failures are detected and recovered.</small></div>
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  </div>;
}
