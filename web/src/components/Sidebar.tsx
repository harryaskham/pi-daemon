import { createPortal } from "react-dom";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ChevronDown, Info, PanelLeftClose, Plus, Search, Settings2, Sparkles } from "../icons";
import type { InventoryId, SessionFixture } from "../model";
import { recordSearch } from "../performance";
import { scheduleCountdown } from "../schedule";
import { preciseRelativeTime, relativeTime } from "../time";

export type SidebarStatus = "ready" | "loading" | "empty" | "error";
type SessionFilter = "all" | "running" | "unread" | "scheduled" | "managed" | "external";

interface SidebarProps {
  sessions: SessionFixture[];
  query: string;
  selectedInventoryId?: InventoryId;
  status?: SidebarStatus;
  reconciling?: boolean;
  fixtureMode?: boolean;
  connectionLabel?: string;
  summaryLabel?: string;
  schedulesAvailable?: boolean;
  draftsAvailable?: boolean;
  onQueryChange(query: string): void;
  onNewSession(): void;
  onOpenChat(session: SessionFixture): void;
  onOpenInfo(session: SessionFixture): void;
  onOpenSettings(): void;
  onRequestClose(): void;
  onRetry?(): void;
}

interface InfoTooltipState {
  session: SessionFixture;
  top: number;
  left: number;
}

function presenceLabel(session: SessionFixture, schedulesAvailable = true): string {
  if (session.presence.runtime === "failed") return "Failed";
  if (session.presence.runtime === "running") return "Running";
  if (schedulesAvailable && session.presence.scheduled) return `Scheduled ${preciseRelativeTime(session.presence.scheduled.nextWakeAt)}`;
  if (session.presence.activation !== "untouched") return "Activated";
  return session.presence.runtime === "resident-idle" ? "Resident and idle" : "Dormant";
}

function matchesFilter(session: SessionFixture, filter: SessionFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "running": return session.presence.runtime === "running";
    case "unread": return session.presence.unread;
    case "scheduled": return session.presence.scheduled !== undefined;
    case "managed": return session.sourceKind === "managed";
    case "external": return session.sourceKind !== "managed";
  }
}

function SessionInfoTooltip({ state, schedulesAvailable }: { state: InfoTooltipState; schedulesAvailable: boolean }) {
  const { session } = state;
  return createPortal(
    <div
      id="session-info-tooltip"
      className="session-info-tooltip"
      role="tooltip"
      style={{ top: state.top, left: state.left }}
      data-testid="session-info-tooltip"
    >
      <header>
        <span className={`presence-dot presence-dot--${session.presence.runtime}`} />
        <div><strong>{session.title}</strong><span>{presenceLabel(session, schedulesAvailable)}</span></div>
      </header>
      <dl>
        <div><dt>Source</dt><dd>{session.sourceKind}</dd></div>
        <div><dt>Messages</dt><dd>{session.messageCount.toLocaleString()}</dd></div>
        <div><dt>Project</dt><dd>{session.projectLabel ?? session.project}</dd></div>
        <div><dt>Working dir</dt><dd>{session.cwd}</dd></div>
      </dl>
      <p>Open the information view for ownership, identity, policy, and runtime details.</p>
    </div>,
    document.body,
  );
}

function SidebarSkeleton() {
  return (
    <div className="sidebar-list-state sidebar-list-state--loading" aria-label="Loading sessions" aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
    </div>
  );
}

export function Sidebar({
  sessions,
  query,
  selectedInventoryId,
  status = "ready",
  reconciling = false,
  fixtureMode = false,
  connectionLabel = "Same-origin authenticated stream",
  summaryLabel = "indexed sessions",
  schedulesAvailable = false,
  draftsAvailable = false,
  onQueryChange,
  onNewSession,
  onOpenChat,
  onOpenInfo,
  onOpenSettings,
  onRequestClose,
  onRetry,
}: SidebarProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [infoTooltip, setInfoTooltip] = useState<InfoTooltipState>();
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  useEffect(() => {
    if (!schedulesAvailable || !sessions.some((session) => session.presence.runtime !== "running" && session.presence.scheduled !== undefined)) return;
    const interval = window.setInterval(() => setCountdownNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [schedulesAvailable, sessions]);
  const deferredQuery = useDeferredValue(query);
  const counts = useMemo(() => ({
    running: sessions.filter((session) => session.presence.runtime === "running").length,
    unread: sessions.filter((session) => session.presence.unread).length,
    scheduled: sessions.filter((session) => session.presence.scheduled).length,
    managed: sessions.filter((session) => session.sourceKind === "managed").length,
    external: sessions.filter((session) => session.sourceKind !== "managed").length,
  }), [sessions]);
  const searchIndex = useMemo(
    () => sessions.map((session) => ({
      session,
      text: `${session.title}\n${session.cwd}\n${session.projectLabel ?? session.project}\n${session.managed?.sessionId ?? session.sessionId}`.toLocaleLowerCase(),
    })),
    [sessions],
  );
  const filtered = useMemo(() => {
    const startedAt = performance.now();
    const normalized = deferredQuery.trim().toLocaleLowerCase();
    const result = searchIndex
      .filter((entry) => matchesFilter(entry.session, filter))
      .filter((entry) => normalized.length === 0 || entry.text.includes(normalized))
      .map((entry) => entry.session);
    recordSearch(performance.now() - startedAt);
    return result;
  }, [deferredQuery, filter, searchIndex]);

  const virtualizer = useVirtualizer({
    count: status === "ready" ? filtered.length : 0,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 72,
    overscan: 7,
  });

  function showInfoTooltip(session: SessionFixture, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    const maxTop = Math.max(12, window.innerHeight - 238);
    setInfoTooltip({ session, top: Math.min(maxTop, Math.max(12, rect.top - 14)), left: rect.right + 9 });
  }

  function selectFilter(nextFilter: SessionFilter): void {
    setFilter(nextFilter);
    scrollerRef.current?.scrollTo({ top: 0 });
  }

  return (
    <aside className="sidebar" aria-label="Sessions">
      <header className="sidebar__header">
        <div className="brand-mark" aria-hidden="true"><Sparkles size={17} /></div>
        <div>
          <p className="eyebrow">Pi Daemon</p>
          <h1>Dash</h1>
        </div>
        {fixtureMode || reconciling ? <span className={`fixture-badge${reconciling ? " fixture-badge--active" : ""}`}>{reconciling ? "Reconciling" : "Fixture"}</span> : null}
        <button type="button" className="sidebar-close-button" onClick={onRequestClose} aria-label="Close session drawer"><PanelLeftClose size={17} /></button>
      </header>

      <div className="sidebar__summary" aria-label="Session summary">
        <strong>{sessions.length.toLocaleString()}</strong>
        <span>{summaryLabel}</span>
        <span className="summary-pulse"><i />{counts.running} live</span>
      </div>

      {draftsAvailable ? (
        <button type="button" className="new-session-button" onClick={onNewSession} aria-label="Create new session draft">
          <Plus size={15} />
          <span>New session</span>
          <kbd>⌘N</kbd>
        </button>
      ) : <span className="new-session-button-placeholder" aria-hidden="true" />}

      <label className="search-field">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Search sessions</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search title, project, path…"
          spellCheck={false}
          data-testid="session-search"
        />
        <kbd>⌘K</kbd>
      </label>

      <nav className="sidebar-controls" aria-label="Session filters">
        <div className="sidebar__filters">
          {(["all", "running", "unread"] as const).map((value) => (
            <button
              key={value}
              className={`filter-chip${filter === value ? " filter-chip--active" : ""}`}
              type="button"
              aria-pressed={filter === value}
              onClick={() => selectFilter(value)}
            >{value[0]?.toLocaleUpperCase()}{value.slice(1)} <span>{value === "all" ? sessions.length.toLocaleString() : counts[value].toLocaleString()}</span></button>
          ))}
        </div>
        <details className="sidebar-groups">
          <summary><span>Browse by state and source</span><ChevronDown size={13} /></summary>
          <div>
            {schedulesAvailable ? <button type="button" aria-pressed={filter === "scheduled"} onClick={() => selectFilter("scheduled")}><span>Scheduled</span><strong>{counts.scheduled.toLocaleString()}</strong></button> : null}
            <button type="button" aria-pressed={filter === "managed"} onClick={() => selectFilter("managed")}><span>Managed</span><strong>{counts.managed.toLocaleString()}</strong></button>
            <button type="button" aria-pressed={filter === "external"} onClick={() => selectFilter("external")}><span>External & imported</span><strong>{counts.external.toLocaleString()}</strong></button>
          </div>
        </details>
      </nav>

      <div
        ref={scrollerRef}
        className="session-list"
        role="listbox"
        aria-label={`${filtered.length.toLocaleString()} sessions`}
        aria-busy={status === "loading"}
        tabIndex={0}
        onScroll={() => setInfoTooltip(undefined)}
      >
        {status === "loading" ? <SidebarSkeleton /> : null}
        {status === "error" ? (
          <div className="sidebar-list-state sidebar-list-state--error" role="alert">
            <AlertCircle size={21} /><strong>Session index unavailable</strong><span>The last safe workspace remains intact.</span>
            <button type="button" onClick={onRetry}>Retry inventory</button>
          </div>
        ) : null}
        {status === "empty" || (status === "ready" && filtered.length === 0) ? (
          <div className="sidebar-list-state sidebar-list-state--empty">
            <Search size={20} />
            <strong>{filter === "all" ? "No sessions found" : `No ${filter} sessions`}</strong>
            <span>Try another filter, title, project, session ID, or path.</span>
          </div>
        ) : null}
        {status === "ready" && filtered.length > 0 ? (
          <div className="session-list__sizer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const session = filtered[row.index];
              if (!session) return null;
              const selected = session.inventoryId === selectedInventoryId;
              const sessionStatus = presenceLabel(session, schedulesAvailable);
              return (
                <div
                  key={session.inventoryId}
                  className="session-row-wrap"
                  style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                  data-session-row
                  data-index={row.index}
                >
                  <button
                    type="button"
                    className={`session-row${selected ? " session-row--selected" : ""}`}
                    role="option"
                    aria-selected={selected}
                    aria-setsize={filtered.length}
                    aria-posinset={row.index + 1}
                    onClick={() => onOpenChat(session)}
                  >
                    <span
                      className={`presence-dot presence-dot--${session.presence.runtime}${schedulesAvailable && session.presence.runtime !== "running" && session.presence.scheduled ? " presence-dot--scheduled" : ""}${session.presence.unread ? " presence-dot--unread" : ""}`}
                      role="img"
                      aria-label={sessionStatus}
                    />
                    <span className="session-row__copy">
                      <strong>{session.title}</strong>
                      <span>{session.projectLabel ?? session.project}<i>·</i>{session.cwdBasename ?? session.cwd.split("/").at(-1)}</span>
                    </span>
                    {schedulesAvailable && session.presence.runtime !== "running" && session.presence.scheduled ? <time className="session-row__countdown" dateTime={session.presence.scheduled.nextWakeAt} title={`Next wake ${preciseRelativeTime(session.presence.scheduled.nextWakeAt, countdownNow)}`}>{scheduleCountdown(session.presence.scheduled.nextWakeAt, countdownNow)}</time> : <time
                      dateTime={session.modifiedAt}
                      title={preciseRelativeTime(session.modifiedAt)}
                    >{relativeTime(session.modifiedAt)}</time>}
                  </button>
                  <button
                    type="button"
                    className="session-info-button"
                    aria-label={`Open information for ${session.title}`}
                    aria-describedby="session-info-tooltip"
                    onMouseEnter={(event) => showInfoTooltip(session, event.currentTarget)}
                    onMouseLeave={() => setInfoTooltip(undefined)}
                    onFocus={(event) => showInfoTooltip(session, event.currentTarget)}
                    onBlur={() => setInfoTooltip(undefined)}
                    onClick={() => onOpenInfo(session)}
                  ><Info size={14} /></button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <footer className="sidebar__footer">
        <button type="button" onClick={onOpenSettings} className="settings-button">
          <Settings2 size={16} />
          <span>Settings</span>
          <kbd>⌘,</kbd>
        </button>
        <div className="connection-state" role="status"><i /> {connectionLabel}</div>
      </footer>
      {infoTooltip ? <SessionInfoTooltip state={infoTooltip} schedulesAvailable={schedulesAvailable} /> : null}
    </aside>
  );
}
