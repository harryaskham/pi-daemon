import { lazy, Suspense, useMemo, useState } from "react";
import type {
  DashboardSessionDraftResource,
  DashboardSessionDraftSendTicket,
} from "@harryaskham/pi-daemon/dashboard-session-draft-contract";
import type { DashboardBackend } from "@harryaskham/pi-daemon/dashboard-contract";
import { Bot, Check, Clock3, X } from "../icons";
import {
  defaultSessionDraftForm,
  draftIdForLocalTarget,
  sessionDraftFormFromSpec,
  validateSessionDraftForm,
  type SessionDraftFormValues,
} from "../session-draft";

const Composer = lazy(() => import("./Composer"));

export interface NewSessionPaneProps {
  backend: DashboardBackend;
  targetId: string;
  initialCwd: string;
  draft?: DashboardSessionDraftResource;
  vimEnabled: boolean;
  composerHistory: string[];
  onToggleVim(): void;
  onSubmitted(value: string): void;
  onPersisted(targetId: string, draft: DashboardSessionDraftResource): void;
  onCancelled(targetId: string): void;
  onMaterialized(
    targetId: string,
    draft: DashboardSessionDraftResource,
    ticket: DashboardSessionDraftSendTicket,
  ): Promise<void>;
}

function ticketStatus(ticket: DashboardSessionDraftSendTicket | undefined): string | undefined {
  if (ticket === undefined) return undefined;
  if (ticket.state === "queued") return "Draft queued for materialization";
  if (ticket.state === "running") return "Creating the runtime and admitting the first message";
  if (ticket.state === "indeterminate") return "First-send outcome is indeterminate; do not submit it again";
  if (ticket.state === "failed") return ticket.error?.message ?? "First send failed";
  return "Session created; attaching the live pane";
}

export function NewSessionPane({
  backend,
  targetId,
  initialCwd,
  draft,
  vimEnabled,
  composerHistory,
  onToggleVim,
  onSubmitted,
  onPersisted,
  onCancelled,
  onMaterialized,
}: NewSessionPaneProps) {
  const [form, setForm] = useState<SessionDraftFormValues>(() =>
    draft === undefined ? defaultSessionDraftForm(initialCwd) : sessionDraftFormFromSpec(draft.spec),
  );
  const [resource, setResource] = useState(draft);
  const [ticket, setTicket] = useState<DashboardSessionDraftSendTicket>();
  const [busy, setBusy] = useState(false);
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const [error, setError] = useState<string>();
  const validation = useMemo(() => validateSessionDraftForm(form), [form]);
  const persisted = resource !== undefined;
  const sendable = !submissionLocked && (resource === undefined || resource.state === "draft");
  const cancellable = resource === undefined || resource.state === "draft";
  const editable = !persisted && !busy;

  function patch<K extends keyof SessionDraftFormValues>(
    key: K,
    value: SessionDraftFormValues[K],
  ): void {
    if (!editable) return;
    setError(undefined);
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function createDraft(persistTarget: boolean): Promise<DashboardSessionDraftResource> {
    if (resource !== undefined) return resource;
    if (validation.spec === undefined) throw new Error("Fix the highlighted draft fields first");
    const draftId = draftIdForLocalTarget(targetId) ?? targetId.slice(0, 128);
    const created = await backend.createSessionDraft({
      requestId: `draft-create-${crypto.randomUUID()}`,
      idempotencyKey: `draft-create-${draftId}`,
      draftId,
      spec: validation.spec,
    });
    setResource(created);
    if (persistTarget) onPersisted(targetId, created);
    return created;
  }

  async function saveDraft(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await createDraft(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Draft creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelDraft(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (resource !== undefined && resource.state === "draft") {
        await backend.cancelSessionDraft(resource.draftId, {
          requestId: `draft-cancel-${crypto.randomUUID()}`,
          idempotencyKey: `draft-cancel-${resource.draftId}-${resource.revision}`,
          expectedRevision: resource.revision,
        });
      }
      onCancelled(targetId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Draft cancellation failed");
      setBusy(false);
    }
  }

  async function submitFirstMessage(message: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(undefined);
    let currentDraft: DashboardSessionDraftResource | undefined;
    try {
      currentDraft = await createDraft(false);
      let current = await backend.sendSessionDraft(currentDraft.draftId, {
        requestId: `draft-send-${crypto.randomUUID()}`,
        idempotencyKey: `draft-send-${currentDraft.draftId}-${crypto.randomUUID()}`,
        expectedRevision: currentDraft.revision,
        message,
      });
      setTicket(current);
      for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(current.state); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        current = await backend.getSessionDraftSend(current.ticketId);
        setTicket(current);
      }
      if (current.state === "succeeded" && current.session !== undefined) {
        await onMaterialized(targetId, currentDraft, current);
        onSubmitted(message);
        return true;
      }
      const updatedDraft = await backend.getSessionDraft(currentDraft.draftId).catch(() => currentDraft);
      setResource(updatedDraft);
      setSubmissionLocked(true);
      if (current.state === "indeterminate") {
        setError("First-send outcome is indeterminate. Inspect the durable ticket before any retry.");
      } else {
        setError(current.error?.message ?? "First send did not create a live session");
      }
      return false;
    } catch (reason) {
      if (currentDraft !== undefined) setSubmissionLocked(true);
      setError(reason instanceof Error ? reason.message : "First send failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const status = error ?? ticketStatus(ticket) ?? resource?.materialization?.error?.message ?? (
    resource?.state === "live"
      ? "Session created. Restoring the managed live pane without replaying the first message."
      : resource?.state === "indeterminate"
        ? "First-send outcome is indeterminate. Inspect the durable ticket before any retry."
        : resource?.state === "failed"
          ? "First send failed. Review the durable result before creating another draft."
          : persisted
            ? "Draft saved. The first message will materialize, attach, and wake this session exactly once."
            : "No network or runtime work has started. Save the draft or send the first message when ready."
  );

  return (
    <section className="new-session-pane" aria-label="New session draft" data-draft-state={resource?.state ?? "local"}>
      <header className="pane-header">
        <div className="pane-title">
          <span className="new-session-icon"><Bot size={16} /></span>
          <div><p className="eyebrow">Pi Daemon · Lazy draft</p><h2>{resource?.spec.name || form.name || "New session"}</h2></div>
        </div>
        <button type="button" className="secondary-button" onClick={() => void cancelDraft()} disabled={busy || !cancellable} aria-label="Cancel new session draft"><X size={14} /> Cancel</button>
      </header>

      <div className="new-session-body">
        <div className="new-session-empty">
          <span><Bot size={22} /></span>
          <h3>An empty conversation</h3>
          <p>Configure bounded session policy below. No Pi runtime or provider request exists until the explicit first send.</p>
        </div>
        <form className="new-session-form" onSubmit={(event) => event.preventDefault()} noValidate>
          <label className="new-session-field new-session-field--wide">
            <span>Working directory</span>
            <input value={form.cwd} onChange={(event) => patch("cwd", event.target.value)} disabled={!editable} aria-invalid={validation.errors.cwd !== undefined} placeholder="/absolute/project/path" />
            {validation.errors.cwd ? <small>{validation.errors.cwd}</small> : null}
          </label>
          <label className="new-session-field">
            <span>Session name <i>optional</i></span>
            <input value={form.name} onChange={(event) => patch("name", event.target.value)} disabled={!editable} aria-invalid={validation.errors.name !== undefined} />
            {validation.errors.name ? <small>{validation.errors.name}</small> : null}
          </label>
          <label className="new-session-field">
            <span>Persistence</span>
            <select value={form.persistence} onChange={(event) => patch("persistence", event.target.value as SessionDraftFormValues["persistence"])} disabled={!editable}><option value="persistent">Persistent JSONL</option><option value="memory">Memory only</option></select>
          </label>
          <label className="new-session-field">
            <span>Provider <i>optional with model</i></span>
            <input value={form.provider} onChange={(event) => patch("provider", event.target.value)} disabled={!editable} aria-invalid={validation.errors.model !== undefined} />
          </label>
          <label className="new-session-field">
            <span>Model ID</span>
            <input value={form.modelId} onChange={(event) => patch("modelId", event.target.value)} disabled={!editable} aria-invalid={validation.errors.model !== undefined} />
            {validation.errors.model ? <small>{validation.errors.model}</small> : null}
          </label>
          <label className="new-session-field">
            <span>Thinking</span>
            <select value={form.thinkingLevel} onChange={(event) => patch("thinkingLevel", event.target.value as SessionDraftFormValues["thinkingLevel"])} disabled={!editable}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{level}</option>)}</select>
          </label>
          <label className="new-session-field">
            <span>Tool policy</span>
            <select value={form.toolsMode} onChange={(event) => patch("toolsMode", event.target.value as SessionDraftFormValues["toolsMode"])} disabled={!editable}><option value="none">No tools</option><option value="allowlist">Allowlist</option></select>
          </label>
          {form.toolsMode === "allowlist" ? <label className="new-session-field new-session-field--wide"><span>Allowed tools <i>comma separated</i></span><input value={form.toolNames} onChange={(event) => patch("toolNames", event.target.value)} disabled={!editable} aria-invalid={validation.errors.tools !== undefined} />{validation.errors.tools ? <small>{validation.errors.tools}</small> : null}</label> : null}
          <details className="new-session-resources new-session-field--wide">
            <summary>Resources and trust policy</summary>
            <div className="new-session-resource-grid">
              {([
                ["noExtensions", "Disable extensions"],
                ["noSkills", "Disable skills"],
                ["noPromptTemplates", "Disable prompt templates"],
                ["noThemes", "Disable themes"],
                ["noContextFiles", "Disable context files"],
              ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={form[key]} onChange={(event) => patch(key, event.target.checked)} disabled={!editable} /> {label}</label>)}
              <label>Project trust <select value={form.projectTrust} onChange={(event) => patch("projectTrust", event.target.value as SessionDraftFormValues["projectTrust"])} disabled={!editable}><option value="deny">Deny discovery</option><option value="default">Default</option></select></label>
              <span>Isolation: unisolated shared process</span>
            </div>
          </details>
        </form>
      </div>

      <footer className="chat-pane__footer new-session-footer">
        <div className={`composer-status ${error ? "composer-status--error" : ticket?.state === "indeterminate" ? "composer-status--warning" : "composer-status--normal"}`} role={error ? "alert" : "status"}>
          {busy ? <Clock3 size={13} /> : persisted ? <Check size={13} /> : <Bot size={13} />}
          <span>{status}</span>
          {!persisted ? <button type="button" onClick={() => void saveDraft()} disabled={busy || validation.spec === undefined}>Save draft</button> : <small>draft r{resource.revision}</small>}
        </div>
        <Suspense fallback={<div className="composer composer--loading"><i /><span>Loading the editor chunk…</span></div>}>
          <Composer
            vimEnabled={vimEnabled}
            history={composerHistory}
            disabled={busy || validation.spec === undefined || !sendable}
            submitLabel="Start session"
            hint="First message starts this session · no runtime exists before send"
            onToggleVim={onToggleVim}
            onSubmit={submitFirstMessage}
          />
        </Suspense>
      </footer>
    </section>
  );
}
