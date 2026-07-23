import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DashboardLiveSessionController, DashboardLiveSessionState } from "../dashboard-live-session";
import {
  adjacentSessionTreeEntry,
  compareSessionTreeEntries,
  filterSessionTree,
  type SessionTreeEntry,
} from "../session-tree";
import { Clock3, GitBranch, Play, Search, TerminalSquare, X } from "../icons";

interface SessionTreeNavigatorProps {
  state: DashboardLiveSessionState;
  controller: DashboardLiveSessionController;
  tuiAvailable: boolean;
  navigationAvailable: boolean;
  onClose(): void;
  onPresentationChange(presentation: "rich" | "tui"): void;
}

export function SessionTreeNavigator({
  state,
  controller,
  tuiAvailable,
  navigationAvailable,
  onClose,
  onPresentationChange,
}: SessionTreeNavigatorProps) {
  const [query, setQuery] = useState("");
  const [labeledOnly, setLabeledOnly] = useState(false);
  const [branchPointsOnly, setBranchPointsOnly] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryInstructions, setSummaryInstructions] = useState("");
  const [summaryLabel, setSummaryLabel] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const model = state.tree;
  const visible = useMemo(
    () => model === undefined ? [] : filterSessionTree(model, { query, labeledOnly, branchPointsOnly }),
    [model, query, labeledOnly, branchPointsOnly],
  );
  const selected = state.treeSelectedEntryId === undefined ? undefined : model?.byId.get(state.treeSelectedEntryId);
  const comparison = model !== undefined && selected !== undefined && state.treeCompareEntryId !== undefined && model.byId.has(state.treeCompareEntryId)
    ? compareSessionTreeEntries(model, selected.id, state.treeCompareEntryId)
    : undefined;
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 42,
    overscan: 12,
  });

  useEffect(() => {
    if (state.treePhase === "idle" || state.treePhase === "stale") void controller.loadTree();
  }, [controller, state.treePhase]);

  useEffect(() => {
    setSummaryOpen(false);
  }, [selected?.id]);

  function select(entry: SessionTreeEntry | undefined): void {
    if (entry === undefined) return;
    controller.selectTreeEntry(entry.id);
    const index = visible.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      select(adjacentSessionTreeEntry(
        visible,
        selected?.id,
        event.key === "ArrowDown" ? "next" : event.key === "ArrowUp" ? "previous" : event.key === "Home" ? "first" : "last",
      ));
      return;
    }
    if (event.key === "ArrowLeft" && selected?.parentId) {
      event.preventDefault();
      select(model?.byId.get(selected.parentId));
      return;
    }
    if (event.key === "ArrowRight" && selected?.childrenIds[0]) {
      event.preventDefault();
      select(model?.byId.get(selected.childrenIds[0]));
      return;
    }
    if (event.key === "Enter" && selected !== undefined) {
      event.preventDefault();
      controller.compareTreeEntry(selected.activeLeaf ? undefined : model?.leafId ?? undefined);
    }
    if (event.key === "Escape") onClose();
  }

  return (
    <aside className="session-tree" aria-label="Session branch tree">
      <header>
        <div><p className="eyebrow"><GitBranch size={12} /> Session tree</p><h3>{model ? `${model.entries.length.toLocaleString()} entries · ${model.branchCount.toLocaleString()} branch points` : "Loading branches"}</h3></div>
        <div className="session-tree__header-actions">
          {state.treePhase === "stale" || state.treePhase === "error" ? <button type="button" onClick={() => void controller.loadTree()} aria-label="Refresh session tree"><Clock3 size={14} /></button> : null}
          {tuiAvailable ? <button type="button" onClick={() => onPresentationChange("tui")} aria-label="Open the same session in TUI"><TerminalSquare size={14} /></button> : null}
          <button type="button" onClick={onClose} aria-label="Close session tree"><X size={15} /></button>
        </div>
      </header>

      <div className="session-tree__filters">
        <label><Search size={13} /><span className="sr-only">Filter tree</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter label, type, or text" /></label>
        <button type="button" aria-pressed={labeledOnly} onClick={() => setLabeledOnly((value) => !value)}>Labeled</button>
        <button type="button" aria-pressed={branchPointsOnly} onClick={() => setBranchPointsOnly((value) => !value)}>Branches</button>
      </div>

      {state.treePhase === "loading" || state.treePhase === "mutating" ? <div className="session-tree__state" role="status"><Clock3 size={15} /> {state.treePhase === "loading" ? "Loading bounded tree…" : "Applying branch action…"}{state.treePhase === "mutating" ? <button type="button" onClick={() => void controller.command("abort")}>Cancel</button> : null}</div> : null}
      {state.treeError ? <div className="session-tree__state session-tree__state--error" role="alert">{state.treeError.message}<button type="button" onClick={() => void controller.loadTree()}>Retry</button></div> : null}

      <div className="session-tree__main">
        <div
          ref={scrollerRef}
          className="session-tree__scroller"
          role="tree"
          aria-label="Versioned conversation branches"
          tabIndex={0}
          onKeyDown={keyDown}
        >
          <div className="session-tree__sizer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const entry = visible[row.index];
              if (entry === undefined) return null;
              return (
                <button
                  type="button"
                  role="treeitem"
                  aria-level={entry.depth}
                  aria-selected={entry.id === selected?.id}
                  aria-current={entry.activeLeaf ? "true" : undefined}
                  aria-expanded={entry.childrenIds.length > 0}
                  key={entry.id}
                  className={`session-tree__row ${entry.onActivePath ? "session-tree__row--active-path" : ""} ${entry.activeLeaf ? "session-tree__row--leaf" : ""}`}
                  style={{ transform: `translateY(${row.start}px)`, paddingInlineStart: `${Math.min(entry.depth - 1, 24) * 12 + 9}px` }}
                  onClick={() => controller.selectTreeEntry(entry.id)}
                >
                  <i aria-hidden="true" />
                  <span><strong>{(entry.label ?? entry.summary) || entry.type}</strong><small>{entry.type}{entry.role ? ` · ${entry.role}` : ""} · {new Date(entry.timestamp).toLocaleString()}</small></span>
                  {entry.branchPoint ? <b>{entry.childrenIds.length}</b> : null}
                </button>
              );
            })}
          </div>
          {visible.length === 0 && state.treePhase === "ready" ? <p className="session-tree__empty">No entries match this bounded filter.</p> : null}
        </div>

        <section className="session-tree__detail" aria-live="polite">
          {selected === undefined ? <p>Select a branch entry.</p> : <>
            <header><div><p className="eyebrow">Selected entry</p><h4>{selected.label ?? selected.type}</h4></div>{selected.activeLeaf ? <span>Active leaf</span> : selected.onActivePath ? <span>Active path</span> : <span>Abandoned branch</span>}</header>
            <p>{selected.summary}</p>
            <dl><div><dt>ID</dt><dd>{selected.id}</dd></div><div><dt>Parent</dt><dd>{selected.parentId ?? "root"}</dd></div><div><dt>Children</dt><dd>{selected.childrenIds.length}</dd></div></dl>
            <div className="session-tree__actions">
              <button type="button" disabled={state.role !== "controller" || state.treePhase === "mutating"} onClick={() => void controller.forkTreeEntry(selected.id)}><GitBranch size={13} /> Fork here</button>
              {selected.userText !== undefined ? <button type="button" disabled={state.role !== "controller" || state.treePhase === "mutating"} onClick={() => void controller.forkTreeEntry(selected.id, true)}><Play size={13} /> Edit & resubmit</button> : null}
              {navigationAvailable ? <button type="button" disabled={state.role !== "controller" || state.treePhase === "mutating" || selected.activeLeaf} onClick={() => void controller.navigateTreeEntry(selected.id)}><Play size={13} /> Navigate here</button> : null}
              {navigationAvailable ? <button type="button" disabled={state.role !== "controller" || state.treePhase === "mutating" || selected.activeLeaf} aria-expanded={summaryOpen} onClick={() => setSummaryOpen((value) => !value)}>Summarize & navigate</button> : null}
              <button type="button" disabled={selected.activeLeaf} onClick={() => controller.compareTreeEntry(selected.activeLeaf ? undefined : model?.leafId ?? undefined)}>Compare with active</button>
              <button type="button" disabled={state.role !== "controller" || state.treePhase === "mutating"} onClick={() => void controller.cloneTree()}>Clone active</button>
            </div>
            {navigationAvailable && summaryOpen && !selected.activeLeaf ? (
              <form className="session-tree__summary" onSubmit={(event) => {
                event.preventDefault();
                void controller.navigateTreeEntry(selected.id, {
                  summarize: true,
                  ...(summaryInstructions.trim().length === 0 ? {} : { customInstructions: summaryInstructions }),
                  ...(summaryLabel.trim().length === 0 ? {} : { label: summaryLabel }),
                }).then((result) => {
                  if (result.state === "completed") setSummaryOpen(false);
                });
              }}>
                <label><span>Summary label</span><input value={summaryLabel} maxLength={512} onChange={(event) => setSummaryLabel(event.target.value)} placeholder="abandoned-branch" /></label>
                <label><span>Summary instructions</span><textarea value={summaryInstructions} maxLength={65_536} rows={3} onChange={(event) => setSummaryInstructions(event.target.value)} placeholder="Optional instructions for the branch summarizer" /></label>
                <button type="submit" disabled={state.treePhase === "mutating"}>Summarize abandoned branch</button>
              </form>
            ) : null}
            {state.role !== "controller" ? <small>Request controller role before mutating the session tree.</small> : null}
          </>}
          {comparison ? <TreeComparison comparison={comparison} /> : null}
        </section>
      </div>
    </aside>
  );
}

function TreeComparison({ comparison }: { comparison: ReturnType<typeof compareSessionTreeEntries> }) {
  return (
    <section className="session-tree__comparison" aria-label="Side-by-side branch comparison">
      <header><strong>Branch comparison</strong><span>common {comparison.commonAncestorId ?? "none"}</span></header>
      <div>
        <BranchPath title="Selected" entries={comparison.leftPath} />
        <BranchPath title="Active" entries={comparison.rightPath} />
      </div>
    </section>
  );
}

function BranchPath({ title, entries }: { title: string; entries: SessionTreeEntry[] }) {
  return <div><h5>{title}</h5>{entries.length === 0 ? <p>Same branch point</p> : entries.map((entry) => <article key={entry.id}><strong>{entry.label ?? entry.type}</strong><p>{entry.summary}</p><small>{entry.timestamp}</small></article>)}</div>;
}
