import { useMemo, useState, type FormEvent } from "react";
import type {
  ExtensionFormField,
  ExtensionFormNode,
  ExtensionViewDocument,
  ExtensionViewNode,
  ExtensionViewResponseValue,
} from "@harryaskham/pi-daemon/extension-view-contract";
import { createExtensionViewResponse } from "@harryaskham/pi-daemon/extension-view-contract";
import type { DashboardExtensionViewEvent } from "@harryaskham/pi-daemon/dashboard-contract";
import { AlertCircle, Check, FileCode2, ShieldCheck, X } from "../icons";

interface DeclarativeExtensionViewProps {
  event: DashboardExtensionViewEvent;
  disabled: boolean;
  onRespond(response: ReturnType<typeof createExtensionViewResponse> | { cancelled: true }): void;
}

export function DeclarativeExtensionView({
  event,
  disabled,
  onRespond,
}: DeclarativeExtensionViewProps) {
  const view = event.view;
  if (view === undefined) {
    return (
      <section className="extension-view extension-view--fallback" role="status">
        <header><div><p className="eyebrow">Extension fallback</p><h3>Declarative view unavailable</h3></div><button type="button" onClick={() => onRespond({ cancelled: true })} disabled={disabled} aria-label="Dismiss extension fallback"><X size={15} /></button></header>
        <p>{event.fallback.text}</p>
        <footer><span>{event.fallback.reason}</span><span>browser code disabled</span></footer>
      </section>
    );
  }

  const respond = (actionId: string, values?: Record<string, ExtensionViewResponseValue>) => {
    onRespond(createExtensionViewResponse(view, actionId, values));
  };

  return (
    <section className="extension-view" role="dialog" aria-label={view.title ?? "Extension view"}>
      <header>
        <div><p className="eyebrow"><ShieldCheck size={12} /> Server-validated extension view</p><h3>{view.title ?? view.viewId}</h3></div>
        <button type="button" onClick={() => onRespond({ cancelled: true })} disabled={disabled} aria-label="Dismiss extension view"><X size={15} /></button>
      </header>
      <div className="extension-view__body">
        <ViewNode node={view.root} path="root" view={view} disabled={disabled} onAction={respond} />
      </div>
      <footer><span>{view.protocol} {view.version}</span><span>rev {view.revision}</span><span>{event.provenance.validator} · no browser code</span></footer>
    </section>
  );
}

function ViewNode({
  node,
  path,
  view,
  disabled,
  onAction,
}: {
  node: ExtensionViewNode;
  path: string;
  view: ExtensionViewDocument;
  disabled: boolean;
  onAction(actionId: string, values?: Record<string, ExtensionViewResponseValue>): void;
}) {
  if (node.type === "text") return <p className="extension-view__text">{node.text}</p>;
  if (node.type === "markdown") return <div className="extension-view__markdown">{node.text.split(/\n{2,}/u).map((block, index) => <p key={`${path}-md-${index}`}>{block}</p>)}</div>;
  if (node.type === "code") return <figure className="extension-view__code">{node.filename ? <figcaption>{node.filename}</figcaption> : null}<pre><code data-language={node.language ?? "text"}>{node.code}</code></pre></figure>;
  if (node.type === "diff") return <pre className="extension-view__diff">{node.diff.split("\n").map((line, index) => <span key={`${path}-diff-${index}`} className={line.startsWith("+") ? "diff-line--add" : line.startsWith("-") ? "diff-line--remove" : ""}>{line || " "}{"\n"}</span>)}</pre>;
  if (node.type === "image") {
    return <figure className="extension-view__image"><FileCode2 size={22} /><figcaption>{node.alt}<small>{node.mediaType}{node.width && node.height ? ` · ${node.width}×${node.height}` : ""} · authorized blob</small></figcaption></figure>;
  }
  if (node.type === "key-value") {
    return <dl className="extension-view__key-value">{node.entries.map((entry, index) => <div key={`${path}-kv-${index}`}><dt>{entry.key}</dt><dd>{entry.value}</dd></div>)}</dl>;
  }
  if (node.type === "status") {
    return <div className={`extension-view__status extension-view__status--${node.tone}`} role={node.tone === "error" ? "alert" : "status"}>{node.tone === "error" || node.tone === "warning" ? <AlertCircle size={14} /> : <Check size={14} />}<div><strong>{node.label}</strong>{node.detail ? <p>{node.detail}</p> : null}</div></div>;
  }
  if (node.type === "stack" || node.type === "grid") {
    const style = node.type === "grid" ? { gridTemplateColumns: `repeat(${node.columns}, minmax(0, 1fr))` } : undefined;
    return <div className={`extension-view__${node.type} ${node.type === "stack" ? `extension-view__stack--${node.gap ?? "normal"}` : ""}`} style={style}>{node.children.map((child, index) => <ViewNode key={`${path}-${index}`} node={child} path={`${path}.${index}`} view={view} disabled={disabled} onAction={onAction} />)}</div>;
  }
  if (node.type === "action") {
    return <button type="button" className={`extension-view__action extension-view__action--${node.tone ?? "default"}`} onClick={() => onAction(node.actionId)} disabled={disabled}>{node.label}</button>;
  }
  return <ExtensionForm node={node} disabled={disabled} onAction={onAction} />;
}

function ExtensionForm({
  node,
  disabled,
  onAction,
}: {
  node: ExtensionFormNode;
  disabled: boolean;
  onAction(actionId: string, values: Record<string, ExtensionViewResponseValue>): void;
}) {
  const initial = useMemo(() => Object.fromEntries(node.fields.map((field) => [field.name, initialValue(field)])), [node]);
  const [values, setValues] = useState<Record<string, ExtensionViewResponseValue>>(initial);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!disabled) onAction(node.submitActionId, values);
  }

  return (
    <form className="extension-view__form" onSubmit={submit}>
      {node.fields.map((field) => <Field key={field.name} field={field} value={values[field.name] ?? initialValue(field)} disabled={disabled} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />)}
      <button type="submit" className="extension-view__action extension-view__action--primary" disabled={disabled}>{node.submitLabel}</button>
    </form>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ExtensionFormField;
  value: ExtensionViewResponseValue;
  disabled: boolean;
  onChange(value: ExtensionViewResponseValue): void;
}) {
  if (field.type === "boolean") {
    return <label className="extension-view__checkbox"><input type="checkbox" checked={value === true} required={field.required} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>{field.label}</span></label>;
  }
  if (field.type === "select") {
    return <label><span>{field.label}</span><select value={String(value)} required={field.required} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  }
  return <label><span>{field.label}</span>{field.type === "multiline" ? <textarea value={String(value)} required={field.required} disabled={disabled} placeholder={field.placeholder} rows={4} onChange={(event) => onChange(event.target.value)} /> : <input type="text" value={String(value)} required={field.required} disabled={disabled} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />}</label>;
}

function initialValue(field: ExtensionFormField): ExtensionViewResponseValue {
  if (field.type === "boolean") return field.initial ?? false;
  if (field.type === "select") return field.initial ?? field.options[0]?.value ?? "";
  return field.initial ?? "";
}
