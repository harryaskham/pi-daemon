import { useEffect, useRef } from "react";
import type { DashboardSettingsResource } from "@harryaskham/pi-daemon/dashboard-contract";
import { Check, Keyboard, MoonStar, Settings2, X } from "../icons";
import type { PreferenceSyncState } from "../use-dashboard-preferences";

interface SettingsModalProps {
  open: boolean;
  vimEnabled: boolean;
  reducedMotion: boolean;
  density: "comfortable" | "compact";
  themeName: string;
  revision: number;
  sources: DashboardSettingsResource["sources"];
  syncState: PreferenceSyncState;
  onClose(): void;
  onVimChange(enabled: boolean): void;
  onReducedMotionChange(enabled: boolean): void;
  onDensityChange(density: "comfortable" | "compact"): void;
  onThemeChange(theme: string): void;
  onReset(): void;
}

function SourceBadge({ source }: { source: "default" | "config" | "runtime" | undefined }) {
  return <span className={`setting-source setting-source--${source ?? "default"}`}>{source ?? "default"}</span>;
}

export function SettingsModal({
  open,
  vimEnabled,
  reducedMotion,
  density,
  themeName,
  revision,
  sources,
  syncState,
  onClose,
  onVimChange,
  onReducedMotionChange,
  onDensityChange,
  onThemeChange,
  onReset,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="settings-dialog" aria-labelledby="settings-dialog-title" onCancel={onClose} onClose={onClose}>
      <div className="settings-dialog__topbar">
        <div><Settings2 size={18} /><div><p className="eyebrow">Workspace</p><h2 id="settings-dialog-title">Settings</h2></div></div>
        <button type="button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
      </div>
      <div className="settings-layout">
        <nav aria-label="Settings categories">
          <button className="settings-nav--active" type="button"><MoonStar size={15} /> Appearance</button>
          <button type="button"><Keyboard size={15} /> Editor & keys</button>
          <button type="button">Transcript</button>
          <button type="button">Cache & limits</button>
        </nav>
        <div className="settings-content">
          <section>
            <div className="setting-heading"><div><h3>Semantic theme</h3><p>Component previews inherit the same validated color, surface, border, motion, and state vocabulary.</p></div><SourceBadge source={sources["theme.name"]} /></div>
            <div className="theme-options" role="radiogroup" aria-label="Dashboard theme">
              {[
                { id: "nord-midnight", name: "Nord Midnight", detail: "Deep · calm · AA contrast" },
                { id: "nord-frost", name: "Nord Frost", detail: "Blue-shifted · crisp · AA contrast" },
              ].map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  role="radio"
                  aria-checked={themeName === theme.id}
                  className={`theme-card${themeName === theme.id ? " theme-card--selected" : ""}`}
                  onClick={() => onThemeChange(theme.id)}
                >
                  <span className={`theme-swatch theme-swatch--${theme.id}`} aria-hidden="true"><i /><i /><i /><i /><i /></span>
                  <span><strong>{theme.name}</strong><small>{theme.detail}</small></span>
                  {themeName === theme.id ? <Check size={16} /> : null}
                </button>
              ))}
            </div>
          </section>
          <section>
            <div className="setting-heading"><div><h3>Density</h3></div><SourceBadge source={sources["theme.density"]} /></div>
            <div className="segmented-control" role="group" aria-label="Interface density">
              {(["comfortable", "compact"] as const).map((value) => (
                <button key={value} type="button" className={density === value ? "is-active" : ""} onClick={() => onDensityChange(value)}>{value}</button>
              ))}
            </div>
          </section>
          <section className="settings-toggle-row">
            <div><div className="setting-heading"><h3>Vim composer</h3><SourceBadge source={sources["editor.mode"]} /></div><p>Modal CodeMirror editing. Pane shortcuts stay outside insert mode.</p></div>
            <button type="button" role="switch" aria-label="Vim composer" aria-checked={vimEnabled} className={`switch${vimEnabled ? " switch--on" : ""}`} onClick={() => onVimChange(!vimEnabled)}><i /></button>
          </section>
          <section className="settings-toggle-row">
            <div><div className="setting-heading"><h3>Reduce motion</h3><SourceBadge source={sources["motion.reduced"]} /></div><p>Preserve state changes without glow, resize, or streaming animation.</p></div>
            <button type="button" role="switch" aria-label="Reduce motion" aria-checked={reducedMotion} className={`switch${reducedMotion ? " switch--on" : ""}`} onClick={() => onReducedMotionChange(!reducedMotion)}><i /></button>
          </section>
        </div>
      </div>
      <footer>
        <span>Runtime overlay · revision {revision} · {syncState}</span>
        <button type="button" className="secondary-button" onClick={onReset}>Revert to configured defaults</button>
        <button type="button" className="primary-button" onClick={onClose}>Done</button>
      </footer>
    </dialog>
  );
}
