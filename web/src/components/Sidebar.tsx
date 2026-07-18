import { useDeferredValue, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Info, Search, Settings2, Sparkles } from "../icons";
import type { InventoryId, SessionFixture } from "../model";
import { recordSearch } from "../performance";
import { preciseRelativeTime, relativeTime } from "../time";

interface SidebarProps {
  sessions: SessionFixture[];
  query: string;
  selectedInventoryId?: InventoryId;
  onQueryChange(query: string): void;
  onOpenChat(session: SessionFixture): void;
  onOpenInfo(session: SessionFixture): void;
  onOpenSettings(): void;
}

function presenceLabel(session: SessionFixture): string {
  if (session.presence.runtime === "failed") return "Failed";
  if (session.presence.runtime === "running") return "Running";
  if (session.presence.scheduled) return `Scheduled ${preciseRelativeTime(session.presence.scheduled.nextWakeAt)}`;
  if (session.presence.activation !== "untouched") return "Activated";
  return session.presence.runtime === "resident-idle" ? "Resident and idle" : "Dormant";
}

export function Sidebar({
  sessions,
  query,
  selectedInventoryId,
  onQueryChange,
  onOpenChat,
  onOpenInfo,
  onOpenSettings,
}: SidebarProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query);
  const searchIndex = useMemo(
    () => sessions.map((session) => ({
      session,
      text: `${session.title}\n${session.cwd}\n${session.project}\n${session.sessionId}`.toLocaleLowerCase(),
    })),
    [sessions],
  );
  const filtered = useMemo(() => {
    const startedAt = performance.now();
    const normalized = deferredQuery.trim().toLocaleLowerCase();
    const result = normalized.length === 0
      ? sessions
      : searchIndex.filter((entry) => entry.text.includes(normalized)).map((entry) => entry.session);
    recordSearch(performance.now() - startedAt);
    return result;
  }, [deferredQuery, searchIndex, sessions]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 72,
    overscan: 7,
  });

  return (
    <aside className="sidebar" aria-label="Sessions">
      <header className="sidebar__header">
        <div className="brand-mark" aria-hidden="true"><Sparkles size={17} /></div>
        <div>
          <p className="eyebrow">Pi Daemon</p>
          <h1>Dash</h1>
        </div>
        <span className="fixture-badge">Fixture</span>
      </header>

      <div className="sidebar__summary" aria-label="Session summary">
        <strong>{sessions.length.toLocaleString()}</strong>
        <span>indexed sessions</span>
        <span className="summary-pulse"><i />{sessions.filter((session) => session.presence.runtime === "running").length} live</span>
      </div>

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

      <nav className="sidebar__filters" aria-label="Session filters">
        <button className="filter-chip filter-chip--active" type="button">All <span>{filtered.length.toLocaleString()}</span></button>
        <button className="filter-chip" type="button">Running <span>{sessions.filter((session) => session.presence.runtime === "running").length}</span></button>
        <button className="filter-chip" type="button">Unread <span>{sessions.filter((session) => session.presence.unread).length.toLocaleString()}</span></button>
      </nav>

      <div
        ref={scrollerRef}
        className="session-list"
        role="listbox"
        aria-label={`${filtered.length.toLocaleString()} sessions`}
        tabIndex={0}
      >
        {filtered.length === 0 ? (
          <div className="sidebar-empty">
            <Search size={20} />
            <strong>No sessions found</strong>
            <span>Try a title, project, session ID, or path.</span>
          </div>
        ) : (
          <div className="session-list__sizer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const session = filtered[row.index];
              if (!session) return null;
              const selected = session.inventoryId === selectedInventoryId;
              const status = presenceLabel(session);
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
                      className={`presence-dot presence-dot--${session.presence.runtime}${session.presence.scheduled ? " presence-dot--scheduled" : ""}${session.presence.unread ? " presence-dot--unread" : ""}`}
                      role="img"
                      aria-label={status}
                    />
                    <span className="session-row__copy">
                      <strong>{session.title}</strong>
                      <span>{session.project}<i>·</i>{session.cwd.split("/").at(-1)}</span>
                    </span>
                    <time
                      dateTime={session.modifiedAt}
                      title={preciseRelativeTime(session.modifiedAt)}
                    >{relativeTime(session.modifiedAt)}</time>
                  </button>
                  <button
                    type="button"
                    className="session-info-button"
                    aria-label={`Open information for ${session.title}`}
                    onClick={() => onOpenInfo(session)}
                  ><Info size={14} /></button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="sidebar__footer">
        <button type="button" onClick={onOpenSettings} className="settings-button">
          <Settings2 size={16} />
          <span>Settings</span>
          <kbd>⌘,</kbd>
        </button>
        <div className="connection-state" role="status"><i /> Local fixture · 4 ms</div>
      </footer>
    </aside>
  );
}
