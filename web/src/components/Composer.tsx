import { useEffect, useMemo, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { Keyboard, Send } from "../icons";

const BUILTIN_COMMANDS = ["/model", "/thinking", "/compact", "/auto-compaction", "/auto-retry", "/abort-retry", "/steering-mode", "/follow-up-mode", "/name", "/tree", "/fork", "/clone", "/abort", "/steer", "/follow-up"] as const;

export interface ComposerProps {
  vimEnabled: boolean;
  history: string[];
  commands?: string[];
  externalValue?: string;
  disabled?: boolean;
  onSubmit(value: string): void;
  onToggleVim(): void;
}

export default function Composer({
  vimEnabled,
  history,
  commands = [],
  externalValue,
  disabled = false,
  onSubmit,
  onToggleVim,
}: ComposerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef("");
  const historyIndexRef = useRef(-1);
  const historyRef = useRef(history);
  const commandsRef = useRef<string[]>([]);
  const submitRef = useRef(onSubmit);
  const disabledRef = useRef(disabled);
  const editableCompartmentRef = useRef(new Compartment());
  const [draft, setDraft] = useState("");
  const [hasValue, setHasValue] = useState(false);
  const commandKey = commands.join("\u0000");
  const availableCommands = useMemo(() => [...new Set([...BUILTIN_COMMANDS, ...commands])].slice(0, 256), [commandKey]);
  const suggestions = draft.startsWith("/") ? availableCommands.filter((command) => command.startsWith(draft.split(/\s/, 1)[0] ?? "")) : [];
  historyRef.current = history;
  commandsRef.current = availableCommands;
  submitRef.current = onSubmit;
  disabledRef.current = disabled;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        editableCompartmentRef.current.of(EditorView.editable.of(!disabledRef.current)),
        EditorView.contentAttributes.of({
          "aria-label": "Message composer",
          "aria-multiline": "true",
          "data-testid": "composer-editor",
        }),
        placeholder("Ask Pi to inspect, build, explain, or refine…"),
        keymap.of([
          {
            key: "Alt-ArrowUp",
            run: (view) => {
              const currentHistory = historyRef.current;
              if (currentHistory.length === 0) return false;
              historyIndexRef.current = Math.min(currentHistory.length - 1, historyIndexRef.current + 1);
              const value = currentHistory[currentHistory.length - 1 - historyIndexRef.current] ?? "";
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } });
              return true;
            },
          },
          {
            key: "Alt-ArrowDown",
            run: (view) => {
              historyIndexRef.current = Math.max(-1, historyIndexRef.current - 1);
              const currentHistory = historyRef.current;
              const value = historyIndexRef.current < 0 ? "" : currentHistory[currentHistory.length - 1 - historyIndexRef.current] ?? "";
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } });
              return true;
            },
          },
          {
            key: "Tab",
            run: (view) => {
              const value = view.state.doc.toString();
              if (!value.startsWith("/")) return false;
              const command = commandsRef.current.find((candidate) => candidate.startsWith(value.split(/\s/, 1)[0] ?? ""));
              if (!command) return false;
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `${command} ` }, selection: { anchor: command.length + 1 } });
              return true;
            },
          },
          {
            key: "Mod-Enter",
            run: (view) => {
              const value = view.state.doc.toString().trim();
              if (!value || disabledRef.current) return true;
              submitRef.current(value);
              historyIndexRef.current = -1;
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          valueRef.current = update.state.doc.toString();
          setDraft(valueRef.current);
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
  }, [vimEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)) });
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || externalValue === undefined || view.state.doc.toString() === externalValue) return;
    valueRef.current = externalValue;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: externalValue },
      selection: { anchor: externalValue.length },
    });
  }, [externalValue]);

  function submit(): void {
    const view = viewRef.current;
    if (!view || disabled) return;
    const value = view.state.doc.toString().trim();
    if (!value) return;
    onSubmit(value);
    historyIndexRef.current = -1;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  }

  return (
    <div className={`composer${disabled ? " composer--disabled" : ""}`} data-editor-root>
      <div ref={hostRef} className="composer__editor" />
      {suggestions.length > 0 ? (
        <div className="composer-completions" role="listbox" aria-label="Command completions">
          {suggestions.slice(0, 6).map((command, index) => (
            <button
              key={command}
              type="button"
              role="option"
              aria-selected={index === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `${command} ` }, selection: { anchor: command.length + 1 } });
                view.focus();
              }}
            >{command}</button>
          ))}
        </div>
      ) : null}
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
