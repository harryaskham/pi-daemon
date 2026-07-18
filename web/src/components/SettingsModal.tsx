import { useEffect, useRef } from "react";
import { Check, Keyboard, MoonStar, Settings2, X } from "../icons";

interface SettingsModalProps {
  open: boolean;
  vimEnabled: boolean;
  reducedMotion: boolean;
  density: "comfortable" | "compact";
  onClose(): void;
  onVimChange(enabled: boolean): void;
  onReducedMotionChange(enabled: boolean): void;
  onDensityChange(density: "comfortable" | "compact"): void;
}

export function SettingsModal({
  open,
  vimEnabled,
  reducedMotion,
  density,
  onClose,
  onVimChange,
  onReducedMotionChange,
  onDensityChange,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="settings-dialog" onCancel={onClose} onClose={onClose}>
      <div className="settings-dialog__topbar">
        <div><Settings2 size={18} /><div><p className="eyebrow">Workspace</p><h2>Settings</h2></div></div>
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
            <h3>Nord Midnight</h3>
            <p>Semantic color, surface, border, motion, and state tokens. Component previews inherit the same validated vocabulary as the workspace.</p>
            <div className="theme-card theme-card--selected">
              <div className="theme-swatch" aria-hidden="true"><i /><i /><i /><i /><i /></div>
              <div><strong>Nord Midnight</strong><span>Dark · AA contrast</span></div>
              <Check size={16} />
            </div>
          </section>
          <section>
            <h3>Density</h3>
            <div className="segmented-control" role="group" aria-label="Interface density">
              {(["comfortable", "compact"] as const).map((value) => (
                <button key={value} type="button" className={density === value ? "is-active" : ""} onClick={() => onDensityChange(value)}>{value}</button>
              ))}
            </div>
          </section>
          <section className="settings-toggle-row">
            <div><h3>Vim composer</h3><p>Modal CodeMirror editing. Pane shortcuts stay outside insert mode.</p></div>
            <button type="button" role="switch" aria-checked={vimEnabled} className={`switch${vimEnabled ? " switch--on" : ""}`} onClick={() => onVimChange(!vimEnabled)}><i /></button>
          </section>
          <section className="settings-toggle-row">
            <div><h3>Reduce motion</h3><p>Preserve state changes without glow, resize, or streaming animation.</p></div>
            <button type="button" role="switch" aria-checked={reducedMotion} className={`switch${reducedMotion ? " switch--on" : ""}`} onClick={() => onReducedMotionChange(!reducedMotion)}><i /></button>
          </section>
        </div>
      </div>
      <footer><span>Runtime overlay · revision 14</span><button type="button" className="secondary-button">Revert to configured defaults</button><button type="button" className="primary-button" onClick={onClose}>Done</button></footer>
    </dialog>
  );
}
