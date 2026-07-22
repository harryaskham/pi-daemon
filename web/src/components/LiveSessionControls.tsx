import { useState } from "react";
import type { DashboardCommandOperation } from "@harryaskham/pi-daemon/dashboard-contract";
import type { JsonObject } from "@harryaskham/pi-daemon/session-api";
import type {
  DashboardLiveSessionController,
  DashboardLiveSessionState,
  LiveExtensionRequest,
} from "../dashboard-live-session";
import { AlertCircle, Check, Clock3, ShieldCheck, X } from "../icons";
import { DeclarativeExtensionView } from "./DeclarativeExtensionView";

interface LiveSessionControlsProps {
  state: DashboardLiveSessionState;
  controller: DashboardLiveSessionController;
}

function ExtensionRequest({
  request,
  controller,
}: {
  request: LiveExtensionRequest;
  controller: DashboardLiveSessionController;
}) {
  const [value, setValue] = useState("");
  const title = typeof request.payload.title === "string" ? request.payload.title : "Extension request";
  const message = typeof request.payload.message === "string" ? request.payload.message : request.method;
  const options = Array.isArray(request.payload.options)
    ? request.payload.options.filter((item): item is string => typeof item === "string").slice(0, 12)
    : [];

  function answer(response: JsonObject): void {
    void controller.answerExtensionUi(request.requestId, response);
  }

  return (
    <section className="extension-ui-card" role="dialog" aria-label={title}>
      <header><div><p className="eyebrow">Extension UI</p><h3>{title}</h3></div><button type="button" onClick={() => answer({ cancelled: true })} aria-label="Dismiss extension request"><X size={15} /></button></header>
      <p>{message}</p>
      {options.length > 0 ? <div className="extension-ui-options">{options.map((option) => <button type="button" key={option} onClick={() => answer({ value: option })}>{option}</button>)}</div> : null}
      {request.method === "input" || request.method === "editor" ? (
        <label><span className="sr-only">Extension response</span><textarea value={value} onChange={(event) => setValue(event.target.value)} rows={request.method === "editor" ? 5 : 2} /></label>
      ) : null}
      <footer>
        <button type="button" className="secondary-button" onClick={() => answer({ confirmed: false, cancelled: true })}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => answer(request.method === "input" || request.method === "editor" ? { value } : { confirmed: true })}><Check size={13} /> Continue</button>
      </footer>
    </section>
  );
}

export function LiveSessionControls({ state, controller }: LiveSessionControlsProps) {
  const waiting = state.phase === "preview-loading" || state.phase === "activating" || state.phase === "hydrating" || state.phase === "reconnecting";

  return (
    <div className="live-session-controls">
      <div className={`live-session-strip live-session-strip--${state.phase}`} role="status">
        {waiting ? <Clock3 size={12} /> : state.role === "controller" ? <ShieldCheck size={12} /> : <AlertCircle size={12} />}
        <span>{state.phase.replaceAll("-", " ")}</span>
        <i />
        <span>{state.role}</span>
        {state.role === "observer" && state.phase === "live" ? <button type="button" onClick={() => void controller.requestControl()}>Request control</button> : null}
        {state.role === "controller" && state.phase === "live" ? <button type="button" onClick={() => void controller.releaseControl()}>Release control</button> : null}
        {Object.entries(state.extensionStatuses).map(([key, value]) => <span className="extension-status" key={key}>{key}: {value}</span>)}
        {state.unread ? <button type="button" onClick={() => controller.markSeen()}>Mark seen</button> : null}
      </div>

      {state.managedSession && (state.phase === "live" || state.phase === "streaming") ? (
        <div className="live-export-actions" aria-label="Session export actions">
          <button type="button" onClick={() => void controller.exportSession("as-new")}>Export copy</button>
          <button type="button" onClick={() => void controller.exportSession("append-to-origin")}>Append to origin</button>
          {state.exportTicket ? <span>{state.exportTicket.mode} · {state.exportTicket.state}</span> : null}
        </div>
      ) : null}
      <div className="extension-notifications" aria-live="polite">
        {state.extensionNotifications.map((notification) => <div className={`extension-notification extension-notification--${notification.type}`} key={notification.requestId}>{notification.message}</div>)}
      </div>
      <div className="extension-ui-stack">
        {state.extensionRequests.map((request) => <ExtensionRequest key={request.requestId} request={request} controller={controller} />)}
        {state.extensionViews.map((event) => (
          <DeclarativeExtensionView
            key={event.requestId}
            event={event}
            disabled={state.role !== "controller"}
            onRespond={(response) => void controller.answerExtensionUi(event.requestId, response as JsonObject)}
          />
        ))}
      </div>
    </div>
  );
}

export function commandPayload(operation: DashboardCommandOperation, value?: string): JsonObject {
  if (operation === "prompt" || operation === "steer" || operation === "follow_up") return { message: value ?? "" };
  if (operation === "set_session_name") return { name: value ?? "" };
  if (operation === "set_model") {
    const reference = (value ?? "").trim();
    const separator = reference.indexOf("/");
    return separator <= 0 || separator === reference.length - 1
      ? { provider: "", modelId: reference }
      : {
          provider: reference.slice(0, separator),
          modelId: reference.slice(separator + 1),
        };
  }
  if (operation === "set_thinking_level") return { level: value ?? "medium" };
  return {};
}
