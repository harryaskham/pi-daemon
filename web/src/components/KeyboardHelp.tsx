import { useEffect, useRef } from "react";
import { Keyboard, X } from "../icons";

interface KeyboardHelpProps {
  open: boolean;
  onClose(): void;
}

const shortcuts = [
  ["Ctrl-h / j / k / l", "Move focus to the nearest pane"],
  ["Ctrl-Shift-h / j / k / l", "Swap the focused pane with its neighbor"],
  ["Arrow keys on a divider", "Resize the split by three percent"],
  ["Cmd/Ctrl-Enter", "Send the composer"],
  ["Alt-Up / Alt-Down", "Recall older or newer composer history"],
  ["Tab after /", "Accept the first command completion"],
  ["Cmd/Ctrl-,", "Open settings"],
  ["?", "Open this keyboard guide"],
] as const;

export function KeyboardHelp({ open, onClose }: KeyboardHelpProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={dialogRef} className="keyboard-dialog" aria-labelledby="keyboard-dialog-title" onCancel={onClose} onClose={onClose}>
      <header><div><Keyboard size={18} /><div><p className="eyebrow">Workspace</p><h2 id="keyboard-dialog-title">Keyboard guide</h2></div></div><button type="button" onClick={onClose} aria-label="Close keyboard guide"><X size={18} /></button></header>
      <p>Pane shortcuts are suspended while the composer owns focus. Vim insert/normal behavior remains CodeMirror-owned.</p>
      <dl>{shortcuts.map(([keys, description]) => <div key={keys}><dt>{keys}</dt><dd>{description}</dd></div>)}</dl>
      <footer><button type="button" className="primary-button" onClick={onClose}>Done</button></footer>
    </dialog>
  );
}
