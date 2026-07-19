import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, Clock3, Sparkles } from "../icons";
import {
  cronHumanPreview,
  draftFromSchedule,
  newScheduleDraft,
  scheduleMutation,
  validateScheduleDraft,
  type ScheduleBackend,
  type ScheduleCapabilities,
  type ScheduleDraft,
  type ScheduleResource,
} from "../schedule";
import { preciseRelativeTime } from "../time";

interface ScheduleEditorProps {
  backend: ScheduleBackend;
  sessionRef: string;
}

type LoadState = "loading" | "ready" | "error";

export function ScheduleEditor({ backend, sessionRef }: ScheduleEditorProps) {
  const [capabilities, setCapabilities] = useState<ScheduleCapabilities>();
  const [schedules, setSchedules] = useState<ScheduleResource[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<ScheduleDraft>(() => newScheduleDraft(sessionRef));
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const selected = schedules.find((schedule) => schedule.scheduleId === selectedId);
  const errors = useMemo(() => capabilities === undefined ? {} : validateScheduleDraft(draft, capabilities), [capabilities, draft]);

  useEffect(() => {
    let current = true;
    setState("loading");
    Promise.all([backend.scheduleCapabilities(), backend.listSchedules(sessionRef)]).then(([nextCapabilities, nextSchedules]) => {
      if (!current) return;
      setCapabilities(nextCapabilities);
      setSchedules(nextSchedules);
      const first = nextSchedules[0];
      setSelectedId(first?.scheduleId);
      setDraft(first === undefined ? newScheduleDraft(sessionRef) : draftFromSchedule(first));
      setState("ready");
    }).catch((reason: unknown) => {
      if (!current) return;
      setError(message(reason, "Schedules could not be loaded."));
      setState("error");
    });
    return () => { current = false; };
  }, [backend, sessionRef]);

  function patch<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(undefined);
    setConfirmingDelete(false);
  }

  function choose(schedule: ScheduleResource): void {
    setSelectedId(schedule.scheduleId);
    setDraft(draftFromSchedule(schedule));
    setError(undefined);
    setConfirmingDelete(false);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (Object.keys(errors).length > 0) {
      setError("Correct the highlighted schedule fields before saving.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const result = selected === undefined
        ? await backend.createSchedule(scheduleMutation(draft))
        : await backend.updateSchedule(selected.scheduleId, scheduleMutation(draft, selected.revision));
      setSchedules((current) => [...current.filter((item) => item.scheduleId !== result.scheduleId), result].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setSelectedId(result.scheduleId);
      setDraft(draftFromSchedule(result));
    } catch (reason) { setError(actionableError(reason)); }
    finally { setSaving(false); }
  }

  async function toggle(): Promise<void> {
    if (selected === undefined) return;
    setSaving(true);
    try {
      const toggled = { ...draftFromSchedule(selected), enabled: !selected.enabled };
      const result = await backend.updateSchedule(selected.scheduleId, scheduleMutation(toggled, selected.revision));
      setSchedules((current) => current.map((item) => item.scheduleId === result.scheduleId ? result : item));
      setDraft(draftFromSchedule(result));
      setError(undefined);
    } catch (reason) { setError(actionableError(reason)); }
    finally { setSaving(false); }
  }

  async function remove(): Promise<void> {
    if (selected === undefined) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    try {
      const idempotencyKey = `dash-schedule-delete-${selected.scheduleId}-${crypto.randomUUID()}`;
      await backend.deleteSchedule(selected.scheduleId, { requestId: idempotencyKey, idempotencyKey, expectedRevision: selected.revision });
      const remaining = schedules.filter((item) => item.scheduleId !== selected.scheduleId);
      const next = remaining[0];
      setSchedules(remaining);
      setSelectedId(next?.scheduleId);
      setDraft(next === undefined ? newScheduleDraft(sessionRef) : draftFromSchedule(next));
      setError(undefined);
      setConfirmingDelete(false);
    } catch (reason) { setError(actionableError(reason)); }
    finally { setSaving(false); }
  }

  if (state === "loading") return <div className="schedule-loading" aria-label="Loading schedules" aria-busy="true"><i /><i /><i /></div>;
  if (state === "error" || capabilities === undefined) return <div className="schedule-error" role="alert"><AlertCircle size={18} /><strong>Schedules unavailable</strong><p>{error}</p></div>;

  return (
    <section className="schedule-panel" aria-labelledby="schedule-heading">
      <header className="schedule-panel__header">
        <div><p className="eyebrow">Durable automation</p><h3 id="schedule-heading">Schedules</h3></div>
        <button type="button" className="secondary-button" onClick={() => { setSelectedId(undefined); setDraft(newScheduleDraft(sessionRef)); setError(undefined); setConfirmingDelete(false); }}>New schedule</button>
      </header>
      <div className="schedule-tabs" role="tablist" aria-label="Session schedules">
        {schedules.map((schedule) => <button key={schedule.scheduleId} type="button" role="tab" aria-selected={schedule.scheduleId === selectedId} onClick={() => choose(schedule)}><i className={schedule.enabled ? "is-enabled" : ""} />{schedule.scheduleId}</button>)}
        {schedules.length === 0 ? <span>No schedules yet</span> : null}
      </div>
      <form className="schedule-form" onSubmit={(event) => void save(event)} noValidate>
        <div className="schedule-summary-card" data-state={!draft.enabled ? "disabled" : selected?.lastTrigger?.disposition === "admitted" && selected.lastTrigger.terminalTicket === undefined ? "running" : "ready"}>
          <Clock3 size={17} />
          <div><strong>{cronHumanPreview(draft.cron)}</strong><span>{draft.timezone} · {draft.enabled ? "enabled" : "disabled"}</span></div>
          <div><small>Next wake</small><b>{selected?.nextTriggerAt ? preciseRelativeTime(selected.nextTriggerAt) : "after save"}</b></div>
        </div>

        <div className="schedule-field-grid">
          <Field label="Cron expression" error={errors.cron}><input value={draft.cron} onChange={(event) => patch("cron", event.target.value)} aria-invalid={errors.cron !== undefined} spellCheck={false} /></Field>
          <Field label="IANA timezone" error={errors.timezone}><input value={draft.timezone} onChange={(event) => patch("timezone", event.target.value)} aria-invalid={errors.timezone !== undefined} spellCheck={false} /><small>DST gaps are skipped; repeated civil times run twice.</small></Field>
        </div>
        <Field label="Prompt" error={errors.prompt}><textarea rows={5} value={draft.prompt} onChange={(event) => patch("prompt", event.target.value)} aria-invalid={errors.prompt !== undefined} placeholder={draft.promptConfigured ? "Prompt configured · leave blank to retain it" : "What should Pi do at wake time?"} autoComplete="off" /><small>Sensitive content is input-only and never returned to browser JavaScript. Do not include reusable credentials.</small></Field>

        <details className="schedule-advanced">
          <summary>Model, thinking & wake policy</summary>
          <div className="schedule-field-grid">
            <Field label="Model provider" error={errors.model}><input value={draft.modelProvider} onChange={(event) => patch("modelProvider", event.target.value)} placeholder="Inherit" /></Field>
            <Field label="Model ID" error={errors.model}><input value={draft.modelId} onChange={(event) => patch("modelId", event.target.value)} placeholder="Inherit" /></Field>
            <Field label="Thinking" error={undefined}><select value={draft.thinkingLevel} onChange={(event) => patch("thinkingLevel", event.target.value as ScheduleDraft["thinkingLevel"])}>{["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Overlap" error={undefined}><select value={draft.overlapPolicy} onChange={(event) => patch("overlapPolicy", event.target.value as ScheduleDraft["overlapPolicy"])}><option value="skip">Skip while active</option><option value="queue-one">Queue one</option><option value="reject">Reject</option></select></Field>
            <Field label="Missed wake" error={undefined}><select value={draft.missedWakeMode} onChange={(event) => patch("missedWakeMode", event.target.value as ScheduleDraft["missedWakeMode"])}><option value="skip">Skip</option><option value="run-once">Run once</option><option value="bounded-catch-up">Bounded catch-up</option></select></Field>
            {draft.missedWakeMode === "bounded-catch-up" ? <Field label="Maximum catch-up runs" error={errors.catchUp}><input type="number" min={1} max={capabilities.limits.maxCatchUpRuns} value={draft.maxCatchUpRuns} onChange={(event) => patch("maxCatchUpRuns", event.target.valueAsNumber)} /></Field> : null}
            <Field label="Jitter (seconds)" error={errors.jitter}><input type="number" min={0} max={capabilities.limits.maxJitterMs / 1_000} value={draft.jitterSeconds} onChange={(event) => patch("jitterSeconds", event.target.valueAsNumber)} /></Field>
            <Field label="Max admission delay (seconds)" error={errors.delay}><input type="number" min={0} max={capabilities.limits.maxAdmissionDelayMs / 1_000} value={draft.maxAdmissionDelaySeconds} onChange={(event) => patch("maxAdmissionDelaySeconds", event.target.valueAsNumber)} /></Field>
          </div>
        </details>

        {selected?.lastTrigger ? <ScheduleHistory schedule={selected} /> : null}
        {error ? <div className="schedule-action-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div> : null}
        <footer className="schedule-actions">
          {selected ? <button type="button" className="danger-button" disabled={saving} onClick={() => void remove()}>{confirmingDelete ? "Confirm delete" : "Delete"}</button> : null}
          {selected ? <button type="button" className="secondary-button" disabled={saving} onClick={() => void toggle()}>{selected.enabled ? "Disable" : "Enable"}</button> : null}
          <button type="submit" className="primary-button" disabled={saving || Object.keys(errors).length > 0}><Sparkles size={14} />{saving ? "Saving…" : selected ? "Save changes" : "Create schedule"}</button>
        </footer>
      </form>
    </section>
  );
}

function Field({ label, error, children }: { label: string; error: string | undefined; children: React.ReactNode }) {
  return <label className="schedule-field"><span>{label}</span>{children}{error ? <em>{error}</em> : null}</label>;
}

function ScheduleHistory({ schedule }: { schedule: ScheduleResource }) {
  const trigger = schedule.lastTrigger!;
  const ticket = trigger.terminalTicket;
  return <section className="schedule-history" aria-labelledby={`history-${schedule.scheduleId}`}><h4 id={`history-${schedule.scheduleId}`}>Last wake</h4><div><span className={`history-state history-state--${ticket?.state ?? trigger.disposition}`} /> <strong>{ticket?.state ?? trigger.disposition}</strong><time dateTime={trigger.observedAt}>{new Date(trigger.observedAt).toLocaleString()}</time></div>{ticket ? <p>Durable ticket <code>{ticket.ticketId}</code>{ticket.errorCode ? <> · <b>{ticket.errorCode}</b></> : null}</p> : <p>{trigger.disposition === "admitted" ? "The durable ticket is still running." : "No ticket was admitted for this occurrence."}</p>}</section>;
}

function actionableError(reason: unknown): string {
  const text = message(reason, "The schedule could not be saved.");
  if (/revision|precondition|conflict/iu.test(text)) return "This schedule changed elsewhere. Reload the information pane before retrying.";
  if (/timezone/iu.test(text)) return "The daemon rejected this timezone. Choose a supported IANA name and retry.";
  if (/capacity|limit/iu.test(text)) return "The negotiated schedule limit was reached. Remove a schedule or reduce the requested value.";
  return text;
}

function message(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message.length > 0 ? reason.message : fallback; }
