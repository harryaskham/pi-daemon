import {
  Activity,
  BrainCircuit,
  Clock3,
  Cpu,
  FileCode2,
  Gauge,
  GitBranch,
  ShieldCheck,
  Sparkles,
} from "../icons";
import type { SessionInfoResource } from "@harryaskham/pi-daemon/dashboard-contract";
import type { ReactNode } from "react";
import type { SessionFixture } from "../model";
import { modelLabel } from "../model-label";
import { contextPercentLabel } from "../session-stats";
import { preciseRelativeTime } from "../time";

interface InfoPaneProps {
  session: SessionFixture;
  info?: SessionInfoResource;
  scheduleEditor?: ReactNode;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="info-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function boundedToolNames(names: string[]): string {
  if (names.length === 0) return "none";
  const visible = names.slice(0, 12).join(", ");
  return names.length <= 12 ? visible : `${visible} +${names.length - 12}`;
}

function timingLabel(summary: { count: number; sum: number; max: number }): string {
  if (summary.count === 0) return "no samples";
  return `${Math.round(summary.sum / summary.count)} ms avg · ${Math.round(summary.max)} ms max`;
}

export function InfoPane({ session, info, scheduleEditor }: InfoPaneProps) {
  const tooling = info?.runtime?.toolMaterialization;
  const queue = info?.runtime?.hostToolAdapterQueue;
  const omittedTools = tooling?.entries.filter((entry) => !entry.active) ?? [];
  return (
    <article className="info-pane" aria-label={`Information for ${session.title}`}>
      <header className="info-hero">
        <div className="info-hero__icon"><Sparkles size={20} /></div>
        <p className="eyebrow">Session information</p>
        <h2>{session.title}</h2>
        <div className="info-hero__status">
          <span className={`presence-dot presence-dot--${session.presence.runtime}${scheduleEditor && session.presence.runtime !== "running" && session.presence.scheduled ? " presence-dot--scheduled" : ""}${session.presence.unread ? " presence-dot--unread" : ""}`} />
          {session.presence.runtime.replace("-", " ")}
          <i />
          active {preciseRelativeTime(session.activityAt ?? session.modifiedAt)}
        </div>
      </header>

      <section className="info-section" aria-labelledby="info-overview">
        <h3 id="info-overview">Overview</h3>
        <div className="metric-grid">
          <Metric label="Messages" value={session.messageCount.toLocaleString()} detail="active branch" />
          <Metric label="Tool calls" value={(session.toolCallCount ?? 0).toLocaleString()} detail="bounded output" />
          <Metric
            label="Context"
            value={contextPercentLabel(session.contextPercent)}
            detail={session.contextPercent === null ? "live Pi stats unavailable" : "active context"}
          />
          <Metric label="Generation" value={`#${session.generation}`} detail="current fence" />
        </div>
      </section>

      <section className="info-section" aria-labelledby="info-runtime">
        <h3 id="info-runtime">Runtime & identity</h3>
        <dl className="detail-list">
          <div><dt><Activity size={14} /> Runtime</dt><dd>{session.presence.runtime}</dd></div>
          <div><dt><FileCode2 size={14} /> Source</dt><dd>{session.sourceKind}</dd></div>
          <div><dt><BrainCircuit size={14} /> Model</dt><dd>{modelLabel(session.model)}</dd></div>
          <div><dt><Gauge size={14} /> Thinking</dt><dd>{session.thinking}</dd></div>
          <div><dt><GitBranch size={14} /> Pi session</dt><dd>{session.sessionId}</dd></div>
          <div><dt><Cpu size={14} /> Inventory ID</dt><dd>{session.inventoryId}</dd></div>
          <div><dt><Clock3 size={14} /> Last active</dt><dd>{new Date(session.activityAt ?? session.modifiedAt).toLocaleString()}</dd></div>
          <div><dt><Clock3 size={14} /> Source modified</dt><dd>{new Date(session.modifiedAt).toLocaleString()}</dd></div>
          {info?.source.canonicalPath ? <div><dt><FileCode2 size={14} /> Canonical path</dt><dd>{info.source.canonicalPath}</dd></div> : null}
          {info?.runtime ? <div><dt><Activity size={14} /> Readers / warm leases</dt><dd>{info.runtime.readerCount} / {info.runtime.warmLeaseCount}</dd></div> : null}
        </dl>
      </section>

      {tooling ? (
        <section className="info-section" aria-labelledby="info-tooling">
          <h3 id="info-tooling">Tool materialization</h3>
          <dl className="detail-list">
            <div><dt><Activity size={14} /> State</dt><dd>{tooling.state}{tooling.truncated ? " · truncated" : ""}</dd></div>
            <div><dt><Cpu size={14} /> Active</dt><dd>{boundedToolNames(tooling.active)}</dd></div>
            <div><dt><ShieldCheck size={14} /> Required</dt><dd>{boundedToolNames(tooling.required)}</dd></div>
            <div><dt><FileCode2 size={14} /> Omitted</dt><dd>{omittedTools.length === 0 ? "none" : omittedTools.slice(0, 8).map((entry) => `${entry.name}:${entry.omissionReason ?? "unavailable"}`).join(", ")}</dd></div>
            {tooling.provenance ? <div><dt><GitBranch size={14} /> Materialization</dt><dd>{tooling.provenance.source} · {tooling.provenance.materializationGeneration}</dd></div> : null}
            {tooling.provenance?.authorization ? <div><dt><ShieldCheck size={14} /> Authorization</dt><dd>{tooling.provenance.authorization.source} · {tooling.provenance.authorization.scope}</dd></div> : null}
            {tooling.provenance?.authorization?.ownershipGeneration ? <div><dt><GitBranch size={14} /> Ownership generation</dt><dd>{tooling.provenance.authorization.ownershipGeneration}</dd></div> : null}
          </dl>
        </section>
      ) : null}

      {queue ? (
        <section className="info-section" aria-labelledby="info-tool-queue">
          <h3 id="info-tool-queue">Host tool queue</h3>
          <dl className="detail-list">
            <div>
              <dt><Activity size={14} /> Occupancy</dt>
              <dd>{queue.occupancy.activeRequests} / {queue.capacity.maxConcurrentRequests} active · {queue.occupancy.queuedRequests} / {queue.capacity.maxQueuedRequests} queued</dd>
            </div>
            <div>
              <dt><Gauge size={14} /> High water</dt>
              <dd>{queue.highWater.activeRequests} active · {queue.highWater.queuedRequests} queued</dd>
            </div>
            <div>
              <dt><ShieldCheck size={14} /> Outcomes</dt>
              <dd>{queue.completedRequests} completed · {queue.rejectedRequests} rejected · {queue.cancelledRequests} cancelled · {queue.timedOutRequests} timed out</dd>
            </div>
            <div>
              <dt><Clock3 size={14} /> Saturation</dt>
              <dd>{queue.saturation.active ? "active" : "clear"} · {queue.saturation.count} episode{queue.saturation.count === 1 ? "" : "s"} · {Math.round(queue.saturation.totalMs)} ms total</dd>
            </div>
            {queue.lastRejectionReason ? <div><dt><ShieldCheck size={14} /> Last refusal</dt><dd>{queue.lastRejectionReason}</dd></div> : null}
            {queue.operations.map((operation) => (
              <div key={operation.operation}>
                <dt><Cpu size={14} /> {operation.operation}</dt>
                <dd>{operation.activeRequests} active · {operation.queuedRequests} queued · wait {timingLabel(operation.queueWaitMs)} · latency {timingLabel(operation.requestLatencyMs)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {scheduleEditor}

      <section className="info-section" aria-labelledby="info-policy">
        <h3 id="info-policy">Policy</h3>
        <div className="policy-card">
          <ShieldCheck size={18} />
          <div>
            <strong>{info?.ownership.mode ?? "Trusted"} · {info?.runtime?.isolation ?? "runtime policy pending"}</strong>
            <p>{info?.diagnostics[0]?.message ?? "Preview uses persisted records only. Hydration and controller authority are negotiated separately."}</p>
          </div>
        </div>
      </section>
    </article>
  );
}
