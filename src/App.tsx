import { useEffect, useRef, useState, type FormEvent } from "react";
import { getConfig, saveConfig } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { THEME_EVENT } from "./palette";
import { DataProvider, useDashboard } from "./state";
import type { TimeRangeKey } from "./types";
import CostTab from "./tabs/CostTab";
import RiskTab from "./tabs/RiskTab";
import QualityPrefactorTab from "./tabs/QualityPrefactorTab";
import QualityExternalTab from "./tabs/QualityExternalTab";
import { compact, fmtWhen } from "./lib/util";

/** Prefactor orbit symbol (official brand SVG, recolored via currentColor). */
function OrbitLogo() {
  return (
    <svg viewBox="0 0 55.85 55.83" aria-hidden="true" fill="currentColor">
      <path
        opacity="0.45"
        d="M34.26,21.58c-3.46-3.46-8-5.18-12.53-5.18-1.58,0-3.15.22-4.68.64-1.62,5.94-.11,12.56,4.54,17.21,4.66,4.66,11.27,6.16,17.21,4.55,1.62-5.94.11-12.56-4.54-17.21Z"
      />
      <path d="M21.73,16.4c4.54,0,9.08,1.73,12.53,5.18,4.66,4.66,6.16,11.27,4.54,17.21,1.55-.42,3.04-1.06,4.45-1.91.12-.91.2-1.84.2-2.77,0-5.8-2.26-11.26-6.36-15.36-4.94-4.94-11.69-6.98-18.14-6.15-.84,1.4-1.48,2.89-1.9,4.44,1.53-.42,3.1-.64,4.68-.64Z" />
      <path d="M21.59,34.25c-4.66-4.66-6.16-11.27-4.54-17.21-1.55.42-3.04,1.06-4.45,1.91-.12.91-.2,1.84-.2,2.77,0,5.8,2.26,11.26,6.36,15.36,4.24,4.24,9.8,6.35,15.36,6.35.93,0,1.86-.08,2.78-.2.84-1.4,1.48-2.89,1.9-4.44-5.94,1.62-12.56.11-17.21-4.55Z" />
      <path d="M34.26,46.65c-6.91,6.91-18.16,6.91-25.07,0s-6.91-18.16,0-25.07c1.04-1.04,2.19-1.91,3.4-2.64.22-1.75.65-3.45,1.28-5.07-2.74,1.06-5.3,2.67-7.51,4.88C2.26,22.85,0,28.31,0,34.11s2.26,11.26,6.36,15.36c4.24,4.24,9.8,6.35,15.36,6.35s11.13-2.12,15.36-6.35c2.17-2.17,3.81-4.74,4.89-7.52-1.64.63-3.35,1.05-5.07,1.28-.73,1.22-1.6,2.37-2.64,3.42Z" />
      <path d="M49.49,6.35c-8.47-8.47-22.25-8.47-30.72,0-2.17,2.17-3.81,4.74-4.89,7.52,1.64-.63,3.35-1.05,5.07-1.28.73-1.22,1.6-2.37,2.65-3.42,3.46-3.46,8-5.18,12.53-5.18s9.08,1.73,12.53,5.18c6.91,6.91,6.91,18.16,0,25.07-1.04,1.04-2.19,1.91-3.4,2.64-.22,1.75-.65,3.45-1.28,5.07,2.74-1.06,5.3-2.67,7.51-4.88,4.1-4.1,6.36-9.56,6.36-15.36s-2.26-11.26-6.36-15.36Z" />
      <path d="M38.8,38.79c-.42,1.54-1.06,3.03-1.9,4.44,1.73-.22,3.43-.64,5.07-1.28.63-1.62,1.05-3.32,1.28-5.07-1.41.85-2.9,1.49-4.45,1.91Z" />
      <path d="M17.05,17.04c.42-1.54,1.06-3.03,1.9-4.44-1.73.22-3.43.64-5.07,1.28-.63,1.62-1.05,3.32-1.28,5.07,1.41-.85,2.9-1.49,4.45-1.91Z" />
    </svg>
  );
}

const RANGES: Array<{ key: TimeRangeKey; label: string }> = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

const TABS = [
  { key: "risk", label: "Risk", el: <RiskTab /> },
  { key: "quality-prefactor", label: "Quality · Prefactor", el: <QualityPrefactorTab /> },
  { key: "quality-external", label: "Quality · Your evals", el: <QualityExternalTab /> },
  { key: "cost", label: "Cost", el: <CostTab /> },
] as const;

function ThemeToggle() {
  // ?theme=light|dark|auto overrides the initial (brand-default dark) stamp.
  const [theme, setTheme] = useState<string>(() => {
    const param = new URLSearchParams(location.search).get("theme");
    if (param === "light" || param === "dark" || param === "auto") return param;
    return document.documentElement.dataset.theme ?? "auto";
  });
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    // Tell the charts: they read the palette through a subscription, so
    // without this they'd keep the old theme's colors until the next render.
    window.dispatchEvent(new Event(THEME_EVENT));
  }, [theme]);
  const next = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
  return (
    <button className="ghost" onClick={() => setTheme(next)} title="Toggle color theme">
      {theme === "auto" ? "◐ auto" : theme === "dark" ? "● dark" : "○ light"}
    </button>
  );
}

/**
 * Admin panel: point the dashboard at YOUR Prefactor account by pasting an
 * admin API token. The token is validated against the API, stored by the
 * local server (in .env), and is write-only — nothing in the browser can
 * read it back.
 */
function AdminPanel(props: { host: string; tokenSet: boolean; fromEnv: boolean; onClose: () => void; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [host, setHost] = useState(props.host);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await saveConfig({ token: token.trim() || undefined, host: host.trim() || undefined });
      // Connected, but the server couldn't write it down: say so instead of
      // letting them discover it after the next restart.
      if (!res.persisted) {
        setWarning(
          "Connected, but this token could not be saved to disk, so it will be forgotten when the server restarts. " +
            "Set PREFACTOR_API_TOKEN as an environment variable (or make the data directory writable) to keep it.",
        );
        setBusy(false);
        return;
      }
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !busy && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) props.onClose();
      }}
    >
      <form className="card modal" role="dialog" aria-modal="true" aria-labelledby="admin-title" onSubmit={(e) => void submit(e)}>
        <div className="card-head">
          <h3 id="admin-title">Admin — API connection</h3>
          <span className="toggle">
            <button type="button" onClick={props.onClose} aria-label="Close">
              ✕
            </button>
          </span>
        </div>
        <p className="modal-note">
          Paste your Prefactor <strong>admin API token</strong> (a JWT — not the <code>pf_…</code> SDK ingestion key). It's validated against the API,
          then saved by the local server so it survives restarts. It never leaves this machine and can't be read back from the browser.
        </p>
        {props.fromEnv && (
          <div className="notice" style={{ marginBottom: 12 }}>
            <span>
              A token is set via the <code>PREFACTOR_API_TOKEN</code> environment variable. A token saved here applies immediately, but the
              environment variable wins again on restart — unset it to make a change here permanent.
            </span>
          </div>
        )}
        <label className="field">
          <span>API token {props.tokenSet && <em>(currently configured — leave blank to keep)</em>}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={props.tokenSet ? "••••••••  (unchanged)" : "eyJ…"}
            autoComplete="off"
            spellCheck={false}
            // The panel auto-opens on first run; land the caret where the user
            // needs it instead of making them tab in from the page behind.
            autoFocus
          />
        </label>
        <label className="field">
          <span>API host</span>
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
        </label>
        {error && <div className="error-box">{error}</div>}
        {warning && (
          <div className="notice warn">
            <span>{warning}</span>
          </div>
        )}
        <div className="modal-actions">
          {warning && (
            <button className="ghost" type="button" onClick={props.onSaved}>
              Continue anyway
            </button>
          )}
          <button className="ghost" type="button" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy || (!token.trim() && !props.tokenSet)}>
            {busy ? "Validating…" : "Save & connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Shell() {
  const d = useDashboard();
  // The view lives in the URL — ?tab=cost&range=30d is shareable and
  // survives a reload.
  const [tab, setTabState] = useState<string>(() => new URLSearchParams(location.search).get("tab") ?? "risk");
  const putParam = (key: string, value: string) => {
    const url = new URL(location.href);
    url.searchParams.set(key, value);
    history.replaceState(null, "", url);
  };
  const setTab = (key: string) => {
    setTabState(key);
    putParam("tab", key);
  };
  const setRange = (r: TimeRangeKey) => {
    d.setRange(r);
    putParam("range", r);
  };
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];
  // A 401 with nothing cached means the token is the problem, not the data.
  const authFailed = /\b401\b/.test(d.error ?? "") && d.spans.length === 0 && d.instances.length === 0;

  // Apply ?range= once on load.
  const appliedRange = useRef(false);
  useEffect(() => {
    if (appliedRange.current) return;
    appliedRange.current = true;
    const r = new URLSearchParams(location.search).get("range");
    if (r && RANGES.some((x) => x.key === r) && r !== d.range) d.setRange(r as TimeRangeKey);
  }, [d]);

  // Admin panel state; opens automatically when the server has no token yet.
  const [admin, setAdmin] = useState<{ open: boolean; tokenSet: boolean; host: string; fromEnv: boolean }>({
    open: false,
    tokenSet: true,
    host: "",
    fromEnv: false,
  });
  useEffect(() => {
    const forced = new URLSearchParams(location.search).has("admin");
    getConfig()
      .then((c) => setAdmin({ open: !c.tokenSet || forced, tokenSet: c.tokenSet, host: c.host, fromEnv: Boolean(c.fromEnv) }))
      .catch(() => {});
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <span className="wordmark">
          <OrbitLogo />
          <h1>Prefactor Open Dashboard</h1>
        </span>
        <span className="spacer" />
        <button className="ghost" onClick={() => setAdmin((a) => ({ ...a, open: true }))}>
          ⚙ Admin
        </button>
        <ThemeToggle />
      </div>

      {admin.open && (
        <AdminPanel
          host={admin.host}
          tokenSet={admin.tokenSet}
          fromEnv={admin.fromEnv}
          onClose={() => setAdmin((a) => ({ ...a, open: false }))}
          onSaved={() => {
            setAdmin((a) => ({ ...a, open: false, tokenSet: true }));
            d.reload();
          }}
        />
      )}

      <div className="filters">
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.key} aria-pressed={d.range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <select className="agent-picker" value={d.agentId} onChange={(e) => d.setAgentId(e.target.value)} aria-label="Agent">
          <option value="all">All agents ({d.agents.length})</option>
          {d.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={d.reload}>
          ↻ Refresh
        </button>
        <span className="hint" aria-live="polite">
          {d.refetching
            ? "loading…"
            : `${compact(d.spans.length)} spans · ${compact(d.instances.length)} runs · ` +
              (d.backfilling
                ? "fetching history…"
                : // Never claim "live" while the event stream is down.
                  d.live
                  ? `live · synced ${d.lastSyncAt ? fmtWhen(d.lastSyncAt) : "—"}`
                  : `reconnecting… last synced ${d.lastSyncAt ? fmtWhen(d.lastSyncAt) : "—"}`)}
        </span>
      </div>

      {/* Asking for more history than is cached is normal and slow — say so
          plainly, with what's covered so far, rather than quietly showing a
          shorter range than the one selected. */}
      {d.spansTruncated && (
        <div className={d.horizonLimited && !d.backfilling ? "notice warn" : "notice"}>
          <strong>
            {d.backfilling ? "Fetching older history…" : d.horizonLimited ? "Beyond the fetch horizon" : "Showing history available so far"}
          </strong>
          <span>
            You asked for {RANGES.find((r) => r.key === d.range)?.label ?? "this range"}; charts below cover{" "}
            <strong>{fmtWhen(d.windowStart)} → now</strong>.{" "}
            {d.backfilling ? (
              <>
                The rest is downloading in the background — on a busy account this can take several minutes. Charts extend automatically as it
                arrives, so there's no need to reload, and once fetched this range loads instantly, including after a restart. Cached so far:{" "}
                {compact(d.cachedSpans)} spans.
              </>
            ) : d.horizonLimited ? (
              <>
                History is only fetched back {d.horizonDays} days. To go further, raise <code>BACKFILL_HORIZON_DAYS</code> and restart — the extra
                history downloads once, then stays cached.
              </>
            ) : (
              <>Older data isn't cached for this scope yet.</>
            )}
          </span>
        </div>
      )}

      {d.error && !authFailed && (
        <div className="error-box">
          {d.error}
          {"\n"}The dashboard will keep retrying; open ⚙ Admin to check the API token or host.
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {authFailed ? (
        // A rejected token yields zero data; showing each tab's "how to
        // instrument this" empty state here would blame the wrong thing.
        <div className="card">
          <div className="empty">
            <h4>Your API token was rejected</h4>
            <p>
              The Prefactor API returned <strong>401 Unauthorized</strong>. The token may have expired, been revoked, or belong to a different host —
              and an SDK ingestion key (<code>pf_…</code>) can't read data back.
            </p>
            <p>Paste a current admin token to continue; everything else is already set up.</p>
            <button className="primary" style={{ marginTop: 4 }} onClick={() => setAdmin((a) => ({ ...a, open: true }))}>
              Update API token
            </button>
          </div>
        </div>
      ) : d.needsToken ? (
        <div className="card">
          <div className="empty">
            <h4>Connect your Prefactor account</h4>
            <p>
              Add your admin API token to start watching your agents. Open <strong>⚙ Admin</strong> (top right), paste the token, and the dashboard
              fills in automatically.
            </p>
            <p>
              Find it in the Prefactor app under <em>Account → API Tokens</em>. It stays on this machine — the browser never sees it.
            </p>
            <button className="primary" style={{ marginTop: 4 }} onClick={() => setAdmin((a) => ({ ...a, open: true }))}>
              Add API token
            </button>
          </div>
        </div>
      ) : d.loading ? (
        <div className="empty">Loading your Prefactor data…</div>
      ) : (
        <div className={d.refetching ? "refetching" : undefined}>
          {/* lastSyncAt in the key: a boundary tripped by one bad batch of
              data heals itself when the next sync brings clean data, instead
              of staying broken until the user changes a filter. */}
          <ErrorBoundary resetKey={`${tab}:${d.range}:${d.agentId}:${d.lastSyncAt ?? ""}`}>{active.el}</ErrorBoundary>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  );
}
