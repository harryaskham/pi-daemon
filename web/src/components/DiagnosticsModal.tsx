import { useEffect, useRef, useState } from "react";
import type { DashboardDiagnosticsSnapshot } from "@harryaskham/pi-daemon/dashboard-contract";
import { Activity, Check, X } from "../icons";

interface DiagnosticsModalProps {
  open: boolean;
  available: boolean;
  loadDiagnostics(): Promise<DashboardDiagnosticsSnapshot>;
  onClose(): void;
}

export function DiagnosticsModal({
  open,
  available,
  loadDiagnostics,
  onClose,
}: DiagnosticsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<DashboardDiagnosticsSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || !available) return;
    void refresh();
  }, [open, available]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await loadDiagnostics());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Diagnostics could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function copy(): Promise<void> {
    if (snapshot === undefined) return;
    const text = diagnosticText(snapshot);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("The browser did not allow diagnostics to be copied.");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="diagnostics-dialog"
      aria-labelledby="diagnostics-dialog-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="settings-dialog__topbar">
        <div><Activity size={18} /><div><p className="eyebrow">Service</p><h2 id="diagnostics-dialog-title">Diagnostics</h2></div></div>
        <button type="button" onClick={onClose} aria-label="Close diagnostics"><X size={18} /></button>
      </div>
      <div className="diagnostics-dialog__body">
        <div className="diagnostics-dialog__notice">
          <strong>Browser-safe service events</strong>
          <span>Raw logs, prompts, model output, paths, credentials, and environment values are never exposed here.</span>
        </div>
        {!available ? <div className="diagnostics-empty">This daemon does not advertise browser-safe diagnostics.</div> : null}
        {error !== undefined ? <div className="diagnostics-error" role="alert">{error}</div> : null}
        {snapshot !== undefined ? (
          <>
            <section className="diagnostics-status" aria-label="Daemon configuration status">
              <Status label="Instance" value={snapshot.status.instance} />
              <Status label="Config" value={snapshot.status.configLoaded ? "loaded" : "not loaded"} good={snapshot.status.configLoaded} />
              <Status label="Defaults" value={snapshot.status.sessionDefaultsConfigured ? "configured" : "restricted"} good={snapshot.status.sessionDefaultsConfigured} />
              <Status label="Runtime policy" value={snapshot.status.runtimePolicyConfigured ? "configured" : "restricted"} good={snapshot.status.runtimePolicyConfigured} />
              <Status label="Installed packages" value={snapshot.status.installedPackagesConfigured ? "inherited" : "not inherited"} good={snapshot.status.installedPackagesConfigured} />
              <Status label="Allowed roots" value={String(snapshot.status.allowedRootCount)} />
            </section>
            <section className="diagnostics-events" aria-label="Recent daemon events">
              <div className="diagnostics-events__heading"><h3>Recent events</h3><span>{snapshot.events.length} / {snapshot.limits.maxEvents}</span></div>
              {snapshot.events.length === 0 ? <div className="diagnostics-empty">No diagnostic events have been recorded.</div> : (
                <ol>
                  {[...snapshot.events].reverse().map((event) => (
                    <li key={event.sequence} className={`diagnostic-event diagnostic-event--${event.level}`}>
                      <div><span className="diagnostic-event__level">{event.level}</span><code>{event.code}</code>{event.status === undefined ? null : <span>{event.status}</span>}</div>
                      <p>{event.message}</p>
                      <footer><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time><span>{event.source}</span>{event.route === undefined ? null : <code>{event.route}</code>}</footer>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        ) : loading ? <div className="diagnostics-empty">Loading diagnostics…</div> : null}
      </div>
      <footer className="diagnostics-dialog__footer">
        <span>{snapshot === undefined ? "No snapshot loaded" : `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`}</span>
        <div>
          <button type="button" onClick={() => void refresh()} disabled={!available || loading}>{loading ? "Refreshing…" : "Refresh"}</button>
          <button type="button" onClick={() => void copy()} disabled={snapshot === undefined}>{copied ? <><Check size={14} /> Copied</> : "Copy safe report"}</button>
          <button type="button" className="primary-button" onClick={onClose}>Done</button>
        </div>
      </footer>
    </dialog>
  );
}

function Status({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div><span>{label}</span><strong className={good === undefined ? "" : good ? "diagnostics-good" : "diagnostics-warning"}>{value}</strong></div>;
}

function diagnosticText(snapshot: DashboardDiagnosticsSnapshot): string {
  const status = Object.entries(snapshot.status).map(([key, value]) => `${key}: ${String(value)}`);
  const events = snapshot.events.map((event) => [
    event.timestamp,
    event.level,
    event.source,
    event.code,
    event.status === undefined ? "" : String(event.status),
    event.route ?? "",
    event.message,
  ].filter(Boolean).join(" | "));
  return [
    `Pi Daemon Dash diagnostics (${snapshot.generatedAt})`,
    ...status,
    `rawLogsExposed: ${snapshot.limits.rawLogsExposed}`,
    "",
    ...events,
  ].join("\n");
}
