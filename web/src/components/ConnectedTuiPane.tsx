import { useCallback, useEffect, useState } from "react";
import type { DashboardBackend, DashboardTuiChannel, DashboardTuiChannelEvent, DashboardTuiInput, TuiDimensions } from "@harryaskham/pi-daemon/dashboard-contract";
import type { SessionFixture } from "../model";
import { createTuiFrameStore, tuiFrameStoreReducer, type TuiFrameStoreState } from "../tui-frame-store";
import { TuiPane } from "./TuiPane";

interface ConnectedTuiPaneProps {
  backend: DashboardBackend;
  session: SessionFixture;
  selected: boolean;
  active: boolean;
  onPresentationChange(presentation: "rich" | "tui"): void;
}

export function ConnectedTuiPane({ backend, session, selected, active, onPresentationChange }: ConnectedTuiPaneProps) {
  const [channel, setChannel] = useState<DashboardTuiChannel>();
  const [state, setState] = useState<TuiFrameStoreState>();
  const [error, setError] = useState<string>();
  const sessionRef = session.managed?.sessionId;
  const generation = session.managed?.generation;

  const connect = useCallback(async () => {
    if (sessionRef === undefined || generation === undefined) {
      setError("Activate this session in Rich view before opening its TUI presentation.");
      return;
    }
    setError(undefined);
    const opened = await backend.openTuiChannel({
      sessionRef,
      generation,
      role: selected ? "controller" : "observer",
      dimensions: state?.dimensions ?? { rows: 24, columns: 80 },
      ...(state?.highWaterCursor === undefined ? {} : { cursor: state.highWaterCursor }),
    });
    setChannel(opened);
    setState((current) => current === undefined
      ? createTuiFrameStore(opened.snapshot, opened.role)
      : tuiFrameStoreReducer(current, { type: "snapshot", snapshot: opened.snapshot, role: opened.role }));
    return opened;
  }, [backend, generation, selected, sessionRef, state?.dimensions, state?.highWaterCursor]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let opened: DashboardTuiChannel | undefined;
    void connect().then((value) => {
      if (!current || value === undefined) return value?.close();
      opened = value;
      return undefined;
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "TUI channel is unavailable");
    });
    return () => {
      current = false;
      void opened?.close();
      setChannel(undefined);
    };
  // Re-open only when identity/control intent changes. Snapshot state is carried
  // by the stream channel and must not create an effect loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, backend, generation, selected, sessionRef]);

  useEffect(() => channel?.subscribe((event) => {
    setState((current) => current === undefined ? current : reduceEvent(current, event));
  }), [channel]);

  if (error !== undefined) {
    return <div className="state-panel state-panel--error" role="alert"><h3>TUI presentation unavailable</h3><p>{error}</p><button type="button" onClick={() => onPresentationChange("rich")}>Return to Rich view</button></div>;
  }
  if (state === undefined) {
    return <div className="transcript-skeleton" aria-label="Loading TUI presentation"><i /><i /><i /><i /></div>;
  }
  return (
    <TuiPane
      session={session}
      state={state}
      selected={selected}
      active={active}
      onPresentationChange={onPresentationChange}
      onResize={(dimensions: TuiDimensions) => channel?.resize(dimensions)}
      onInput={(input: DashboardTuiInput) => channel?.sendInput(input)}
      onRequestSnapshot={() => void (async () => {
        await channel?.close();
        setChannel(undefined);
        await connect();
      })().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "TUI reconnect failed"))}
      onRequestControl={() => void channel?.requestControl(`tui-control-${crypto.randomUUID()}`)}
    />
  );
}

function reduceEvent(state: TuiFrameStoreState, event: DashboardTuiChannelEvent): TuiFrameStoreState {
  if (event.kind === "tui_delta") return tuiFrameStoreReducer(state, { type: "delta", delta: event });
  if (event.kind === "replay_gap") return tuiFrameStoreReducer(state, { type: "replay_gap", gap: event });
  return tuiFrameStoreReducer(state, { type: "control", event });
}
