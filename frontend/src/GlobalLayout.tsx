import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { getOverview } from "./api/dashboard";
import { getHealth, getReady } from "./api/system";
import type { HealthResponse, ReadyResponse } from "./api/system";
import { useAuth } from "./auth/AuthContext";
import "./global-layout.css";

const navigation = [
  {
    group: "OVERVIEW",
    links: [{ label: "Command Center", to: "/", icon: "▦", end: true }]
  },
  {
    group: "JOBS",
    links: [
      { label: "All Jobs", to: "/jobs", icon: "▤" },
      { label: "Create Job", to: "/jobs/create", icon: "+" }
    ]
  },
  {
    group: "INFRASTRUCTURE",
    links: [
      { label: "Workers", to: "/workers", icon: "♧" },
      { label: "Queue", to: "/queues", icon: "☷" }
    ]
  },
  {
    group: "OBSERVABILITY",
    links: [{ label: "System Health / Metrics", to: "/system", icon: "⌁" }]
  }
];

export default function GlobalLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [activeWorkers, setActiveWorkers] = useState<number | null>(null);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const [healthResult, readyResult, overviewResult] = await Promise.allSettled([
        getHealth(),
        getReady(),
        getOverview()
      ]);
      if (!mounted) return;
      setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
      setReady(readyResult.status === "fulfilled" ? readyResult.value : null);
      setActiveWorkers(overviewResult.status === "fulfilled" ? overviewResult.value.activeWorkers : null);
    };
    void refresh();
    return () => {
      mounted = false;
    };
  }, []);

  const systemHealthy = health === null || ready === null
    ? null
    : health.status === "healthy"
      && ready.checks.database === "up"
      && ready.checks.redis === "up";

  const handleLogout = async () => {
    setLogoutError("");
    try {
      await logout();
      navigate("/auth", { replace: true });
    } catch (error: unknown) {
      setLogoutError(error instanceof Error ? error.message : "Unable to sign out.");
    }
  };

  return (
    <>
      <aside className="shared-sidebar">
        <Link className="shared-brand" to="/" aria-label="JobMesh Command Center">
          <span className="shared-brand-mark"><i /><i /><i /></span>
          <span><strong>JobMesh</strong><small>Fault-Tolerant Job Queue</small></span>
        </Link>
        <nav aria-label="Main navigation">
          {navigation.map((section) => (
            <section className="shared-nav-section" key={section.group}>
              <div className="shared-nav-label">{section.group}</div>
              {section.links.map((link) => (
                <NavLink
                  to={link.to}
                  end={link.end}
                  key={link.label}
                  className={({ isActive }) => `shared-nav-link${isActive ? " active" : ""}`}
                >
                  <span className="shared-nav-icon" aria-hidden="true">{link.icon}</span>
                  <span>{link.label}</span>
                </NavLink>
              ))}
            </section>
          ))}
        </nav>
        <div className="shared-status">
          <div className={`shared-status-title${systemHealthy === false ? " degraded" : ""}`}>
            <i />{systemHealthy === null ? "CHECKING STATUS" : systemHealthy ? "SYSTEMS STATUS" : "DEGRADED"}
          </div>
          <div><span>API</span><strong>{health ? health.status.toUpperCase() : "UNKNOWN"}</strong></div>
          <div><span>Postgres</span><strong>{ready?.checks.database.toUpperCase() ?? "UNKNOWN"}</strong></div>
          <div><span>Redis</span><strong>{ready?.checks.redis.toUpperCase() ?? "UNKNOWN"}</strong></div>
          <div><span>Workers</span><strong>{activeWorkers ?? "—"}</strong></div>
        </div>
        <div className="shared-account">
          <div className="shared-account-copy">
            <strong>{user?.displayName}</strong>
            <span>{user?.email}</span>
          </div>
          <button type="button" onClick={handleLogout}>Sign out</button>
          {logoutError && <p role="alert">{logoutError}</p>}
        </div>
      </aside>
      <div className="shared-route-content"><Outlet /></div>
    </>
  );
}
