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

export function InfoPane({ session, info, scheduleEditor }: InfoPaneProps) {
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
          <Metric label="Context" value={`${session.contextPercent}%`} detail="hydrated estimate" />
          <Metric label="Generation" value={`#${session.generation}`} detail="current fence" />
        </div>
      </section>

      <section className="info-section" aria-labelledby="info-runtime">
        <h3 id="info-runtime">Runtime & identity</h3>
        <dl className="detail-list">
          <div><dt><Activity size={14} /> Runtime</dt><dd>{session.presence.runtime}</dd></div>
          <div><dt><FileCode2 size={14} /> Source</dt><dd>{session.sourceKind}</dd></div>
          <div><dt><BrainCircuit size={14} /> Model</dt><dd>{session.model}</dd></div>
          <div><dt><Gauge size={14} /> Thinking</dt><dd>{session.thinking}</dd></div>
          <div><dt><GitBranch size={14} /> Pi session</dt><dd>{session.sessionId}</dd></div>
          <div><dt><Cpu size={14} /> Inventory ID</dt><dd>{session.inventoryId}</dd></div>
          <div><dt><Clock3 size={14} /> Last active</dt><dd>{new Date(session.activityAt ?? session.modifiedAt).toLocaleString()}</dd></div>
          <div><dt><Clock3 size={14} /> Source modified</dt><dd>{new Date(session.modifiedAt).toLocaleString()}</dd></div>
          {info?.source.canonicalPath ? <div><dt><FileCode2 size={14} /> Canonical path</dt><dd>{info.source.canonicalPath}</dd></div> : null}
          {info?.runtime ? <div><dt><Activity size={14} /> Readers / warm leases</dt><dd>{info.runtime.readerCount} / {info.runtime.warmLeaseCount}</dd></div> : null}
        </dl>
      </section>

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
