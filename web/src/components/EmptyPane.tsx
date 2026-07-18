import { Command, LayoutGrid, MessageSquareText, Sparkles } from "../icons";

export function EmptyPane() {
  return (
    <div className="empty-pane">
      <div className="empty-pane__orb"><Sparkles size={24} /></div>
      <p className="eyebrow">Ready when you are</p>
      <h2>Choose a session</h2>
      <p>Open a conversation or its information view in this pane. Preview never hydrates a runtime or sends a model turn.</p>
      <div className="empty-pane__actions">
        <span><MessageSquareText size={14} /> Session opens chat</span>
        <span><LayoutGrid size={14} /> Info opens metadata</span>
        <span><Command size={14} /> Ctrl-hjkl moves focus</span>
      </div>
    </div>
  );
}
