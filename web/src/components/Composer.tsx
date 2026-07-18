import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { Keyboard, Send } from "../icons";

export interface ComposerProps {
  vimEnabled: boolean;
  disabled?: boolean;
  onSubmit(value: string): void;
  onToggleVim(): void;
}

export default function Composer({
  vimEnabled,
  disabled = false,
  onSubmit,
  onToggleVim,
}: ComposerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef("");
  const [hasValue, setHasValue] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({
          "aria-label": "Message composer",
          "aria-multiline": "true",
          "data-testid": "composer-editor",
        }),
        placeholder("Ask Pi to inspect, build, explain, or refine…"),
        keymap.of([
          {
            key: "Mod-Enter",
            run: (view) => {
              const value = view.state.doc.toString().trim();
              if (!value || disabled) return true;
              onSubmit(value);
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          valueRef.current = update.state.doc.toString();
          setHasValue(valueRef.current.trim().length > 0);
        }),
        EditorView.theme({
          "&": { backgroundColor: "transparent", color: "var(--dash-fg-primary)", fontSize: "14px" },
          ".cm-content": { caretColor: "var(--dash-accent-primary)", padding: "8px 2px", minHeight: "64px" },
          ".cm-cursor": { borderLeftColor: "var(--dash-accent-primary)" },
          ".cm-gutters": { display: "none" },
          ".cm-activeLine": { backgroundColor: "transparent" },
          ".cm-selectionBackground, ::selection": { backgroundColor: "var(--dash-selection) !important" },
          ".cm-scroller": { fontFamily: "var(--dash-font-sans)", lineHeight: "1.55", maxHeight: "180px" },
          ".cm-placeholder": { color: "var(--dash-fg-dim)" },
          "&.cm-focused": { outline: "none" },
        }),
        ...(vimEnabled ? [vim()] : []),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      valueRef.current = view.state.doc.toString();
      view.destroy();
      viewRef.current = null;
    };
  }, [disabled, onSubmit, vimEnabled]);

  function submit(): void {
    const view = viewRef.current;
    if (!view || disabled) return;
    const value = view.state.doc.toString().trim();
    if (!value) return;
    onSubmit(value);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  }

  return (
    <div className={`composer${disabled ? " composer--disabled" : ""}`} data-editor-root>
      <div ref={hostRef} className="composer__editor" />
      <div className="composer__toolbar">
        <button
          type="button"
          className={`composer-mode${vimEnabled ? " composer-mode--active" : ""}`}
          onClick={onToggleVim}
          aria-pressed={vimEnabled}
          title="Toggle modal Vim editing"
        >
          <Keyboard size={14} /> {vimEnabled ? "VIM · INSERT" : "PLAIN"}
        </button>
        <span className="composer-hint">⌘↵ send · Shift↵ newline</span>
        <button
          type="button"
          className="send-button"
          onClick={submit}
          disabled={!hasValue || disabled}
          aria-label="Send message"
        ><Send size={15} /> Send</button>
      </div>
    </div>
  );
}
