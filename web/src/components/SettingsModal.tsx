import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DashboardSettingsResource, DashboardUiSettings } from "@harryaskham/pi-daemon/dashboard-contract";
import { Check, Keyboard, MoonStar, Settings2, X } from "../icons";
import type { PreferenceSyncState } from "../use-dashboard-preferences";

type SettingsTab = "appearance" | "editor" | "transcript" | "cache";

interface SettingsModalProps {
  open: boolean;
  vimEnabled: boolean;
  submitKey: DashboardUiSettings["editor"]["submitKey"];
  reducedMotion: boolean;
  density: "comfortable" | "compact";
  themeName: string;
  sidebar: DashboardUiSettings["sidebar"];
  transcript: DashboardUiSettings["transcript"];
  cache: DashboardUiSettings["cache"];
  revision: number;
  sources: DashboardSettingsResource["sources"];
  syncState: PreferenceSyncState;
  onClose(): void;
  onVimChange(enabled: boolean): void;
  onSubmitKeyChange(submitKey: DashboardUiSettings["editor"]["submitKey"]): void;
  onReducedMotionChange(enabled: boolean): void;
  onDensityChange(density: "comfortable" | "compact"): void;
  onThemeChange(theme: string): void;
  onSidebarChange(patch: Partial<DashboardUiSettings["sidebar"]>): void;
  onTranscriptChange(patch: Partial<DashboardUiSettings["transcript"]>): void;
  onCacheChange(patch: Partial<DashboardUiSettings["cache"]>): void;
  onReset(): void;
}

const TABS: readonly SettingsTab[] = ["appearance", "editor", "transcript", "cache"];

function SourceBadge({ source }: { source: "default" | "config" | "runtime" | undefined }) {
  return <span className={`setting-source setting-source--${source ?? "default"}`}>{source ?? "default"}</span>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={`switch${checked ? " switch--on" : ""}`} onClick={() => onChange(!checked)}><i /></button>;
}

export function SettingsModal({
  open,
  vimEnabled,
  submitKey,
  reducedMotion,
  density,
  themeName,
  sidebar,
  transcript,
  cache,
  revision,
  sources,
  syncState,
  onClose,
  onVimChange,
  onSubmitKeyChange,
  onReducedMotionChange,
  onDensityChange,
  onThemeChange,
  onSidebarChange,
  onTranscriptChange,
  onCacheChange,
  onReset,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function selectByKey(event: ReactKeyboardEvent<HTMLElement>, tab: SettingsTab): void {
    const index = TABS.indexOf(tab);
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = TABS[(index + delta + TABS.length) % TABS.length]!;
    setActiveTab(next);
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus());
  }

  return (
    <dialog ref={dialogRef} className="settings-dialog" aria-labelledby="settings-dialog-title" onCancel={onClose} onClose={onClose}>
      <div className="settings-dialog__topbar">
        <div><Settings2 size={18} /><div><p className="eyebrow">Workspace</p><h2 id="settings-dialog-title">Settings</h2></div></div>
        <button type="button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
      </div>
      <div className="settings-layout">
        <nav aria-label="Settings categories" role="tablist" aria-orientation="vertical">
          {TABS.map((tab) => {
            const label = tab === "appearance" ? "Appearance" : tab === "editor" ? "Editor & keys" : tab === "transcript" ? "Transcript" : "Cache & limits";
            return <button
              id={`settings-tab-${tab}`}
              key={tab}
              className={activeTab === tab ? "settings-nav--active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`settings-panel-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => selectByKey(event, tab)}
            >{tab === "appearance" ? <MoonStar size={15} /> : tab === "editor" ? <Keyboard size={15} /> : null}{label}</button>;
          })}
        </nav>
        <div className="settings-content" id={`settings-panel-${activeTab}`} role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
          {activeTab === "appearance" ? <>
            <section>
              <div className="setting-heading"><div><h3>Semantic theme</h3><p>Every component inherits one validated color, surface, border, motion, and state vocabulary.</p></div><SourceBadge source={sources["theme.name"]} /></div>
              <div className="theme-options" role="radiogroup" aria-label="Dashboard theme">
                {[
                  { id: "nord-midnight", name: "Nord Midnight", detail: "Deep · calm · AA contrast" },
                  { id: "nord-frost", name: "Nord Frost", detail: "Blue-shifted · crisp · AA contrast" },
                ].map((theme) => <button key={theme.id} type="button" role="radio" aria-checked={themeName === theme.id} className={`theme-card${themeName === theme.id ? " theme-card--selected" : ""}`} onClick={() => onThemeChange(theme.id)}><span className={`theme-swatch theme-swatch--${theme.id}`} aria-hidden="true"><i /><i /><i /><i /><i /></span><span><strong>{theme.name}</strong><small>{theme.detail}</small></span>{themeName === theme.id ? <Check size={16} /> : null}</button>)}
              </div>
            </section>
            <section>
              <div className="setting-heading"><div><h3>Density</h3></div><SourceBadge source={sources["theme.density"]} /></div>
              <div className="segmented-control" role="group" aria-label="Interface density">{(["comfortable", "compact"] as const).map((value) => <button key={value} type="button" className={density === value ? "is-active" : ""} onClick={() => onDensityChange(value)}>{value}</button>)}</div>
            </section>
            <section className="settings-toggle-row"><div><div className="setting-heading"><h3>Reduce motion</h3><SourceBadge source={sources["motion.reduced"]} /></div><p>Preserve state changes without glow, resize, or streaming animation.</p></div><Toggle label="Reduce motion" checked={reducedMotion} onChange={onReducedMotionChange} /></section>
          </> : null}

          {activeTab === "editor" ? <>
            <section className="settings-toggle-row"><div><div className="setting-heading"><h3>Vim composer</h3><SourceBadge source={sources["editor.mode"]} /></div><p>Use maintained modal CodeMirror editing. Pane shortcuts remain outside insert mode.</p></div><Toggle label="Vim composer" checked={vimEnabled} onChange={onVimChange} /></section>
            <section>
              <div className="setting-heading"><div><h3>Send key</h3><p>Choose single-line chat behavior or preserve multiline Enter.</p></div><SourceBadge source={sources["editor.submitKey"]} /></div>
              <div className="segmented-control" role="radiogroup" aria-label="Composer send key">
                <button type="button" role="radio" aria-checked={submitKey === "enter"} className={submitKey === "enter" ? "is-active" : ""} onClick={() => onSubmitKeyChange("enter")}>Enter sends</button>
                <button type="button" role="radio" aria-checked={submitKey === "mod-enter"} className={submitKey === "mod-enter" ? "is-active" : ""} onClick={() => onSubmitKeyChange("mod-enter")}>⌘/Ctrl-Enter sends</button>
              </div>
            </section>
            <section><div className="setting-heading"><div><h3>Keyboard behavior</h3><p>{submitKey === "enter" ? <><kbd>Enter</kbd> sends and <kbd>Shift↵</kbd> inserts a newline.</> : <><kbd>⌘/Ctrl↵</kbd> sends and <kbd>Enter</kbd> inserts a newline.</>} <kbd>Ctrl-h/j/k/l</kbd> moves pane focus, and <kbd>Ctrl-Shift-h/j/k/l</kbd> swaps targets without moving focus.</p></div></div></section>
          </> : null}

          {activeTab === "transcript" ? <>
            <section className="settings-toggle-row"><div><div className="setting-heading"><h3>Expand tool calls</h3><SourceBadge source={sources["transcript.expandTools"]} /></div><p>Open bounded tool details by default. Large output remains capped.</p></div><Toggle label="Expand tool calls" checked={transcript.expandTools} onChange={(value) => onTranscriptChange({ expandTools: value })} /></section>
            <section className="settings-toggle-row"><div><div className="setting-heading"><h3>Expand reasoning</h3><SourceBadge source={sources["transcript.expandThinking"]} /></div><p>Show persisted reasoning cards by default when the source contains them.</p></div><Toggle label="Expand reasoning" checked={transcript.expandThinking} onChange={(value) => onTranscriptChange({ expandThinking: value })} /></section>
            <section className="settings-toggle-row"><div><div className="setting-heading"><h3>Show project labels</h3><SourceBadge source={sources["sidebar.showProject"]} /></div><p>Retain source/project context in the virtualized sidebar.</p></div><Toggle label="Show project labels" checked={sidebar.showProject} onChange={(value) => onSidebarChange({ showProject: value })} /></section>
            <section><div className="setting-heading"><div><h3>Session grouping</h3></div><SourceBadge source={sources["sidebar.groupBy"]} /></div><select aria-label="Session grouping" value={sidebar.groupBy} onChange={(event) => onSidebarChange({ groupBy: event.target.value as DashboardUiSettings["sidebar"]["groupBy"] })}><option value="none">No grouping</option><option value="source">Group by source</option><option value="age">Group by age</option></select></section>
          </> : null}

          {activeTab === "cache" ? <>
            <section><div className="setting-heading"><div><h3>Initial session page</h3><p>Rows requested before server-side search and paging continue.</p></div><SourceBadge source={sources["sidebar.initialLimit"]} /></div><input aria-label="Initial session page" type="number" min={1} max={100} value={sidebar.initialLimit} onChange={(event) => onSidebarChange({ initialLimit: Number(event.target.value) })} /></section>
            <section><div className="setting-heading"><div><h3>Transcript cache entries</h3><p>Bounded warm transcript projections retained for duplicate panes.</p></div><SourceBadge source={sources["cache.transcriptEntries"]} /></div><input aria-label="Transcript cache entries" type="number" min={1} max={64} value={cache.transcriptEntries} onChange={(event) => onCacheChange({ transcriptEntries: Number(event.target.value) })} /></section>
            <section><div className="setting-heading"><div><h3>Transcript cache MiB</h3><p>Browser cache remains an optimization; server state is authoritative.</p></div><SourceBadge source={sources["cache.transcriptBytes"]} /></div><input aria-label="Transcript cache MiB" type="number" min={1} max={64} value={Math.round(cache.transcriptBytes / (1024 * 1024))} onChange={(event) => onCacheChange({ transcriptBytes: Number(event.target.value) * 1024 * 1024 })} /></section>
          </> : null}
        </div>
      </div>
      <footer><span>Runtime overlay · revision {revision} · {syncState}</span><button type="button" className="secondary-button" onClick={onReset}>Revert to configured defaults</button><button type="button" className="primary-button" onClick={onClose}>Done</button></footer>
    </dialog>
  );
}
