import { useEffect, useState } from "react";
import type { DashboardBackend, SessionInfoResource } from "@harryaskham/pi-daemon/dashboard-contract";
import type { SessionFixture } from "../model";
import { InfoPane } from "./InfoPane";

interface ConnectedInfoPaneProps {
  backend: DashboardBackend;
  session: SessionFixture;
  fixtureMode: boolean;
}

export function ConnectedInfoPane({ backend, session, fixtureMode }: ConnectedInfoPaneProps) {
  const [info, setInfo] = useState<SessionInfoResource>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (fixtureMode) return;
    let current = true;
    setInfo(undefined);
    setError(undefined);
    void backend.getSessionInfo(session.inventoryId).then((value) => {
      if (current) setInfo(value);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Session information is unavailable");
    });
    return () => { current = false; };
  }, [backend, fixtureMode, session.inventoryId]);

  if (error !== undefined) {
    return <div className="state-panel state-panel--error" role="alert"><h3>Session information unavailable</h3><p>{error}</p></div>;
  }
  if (!fixtureMode && info === undefined) {
    return <div className="transcript-skeleton" aria-label="Loading session information"><i /><i /><i /><i /></div>;
  }
  const resolved = info === undefined ? session : mergeInfo(session, info);
  return <InfoPane session={resolved} {...(info === undefined ? {} : { info })} />;
}

function mergeInfo(session: SessionFixture, info: SessionInfoResource): SessionFixture {
  return {
    ...session,
    ...info,
    sessionId: info.managed?.sessionId ?? info.piSessionId ?? session.sessionId,
    generation: info.managed?.generation ?? session.generation,
    cwd: info.cwd,
    project: info.projectLabel ?? session.project,
    model: info.runtime?.model?.id ?? session.model,
    thinking: thinkingLevel(info.runtime?.model?.thinkingLevel, session.thinking),
  };
}

function thinkingLevel(value: string | undefined, fallback: SessionFixture["thinking"]): SessionFixture["thinking"] {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : fallback;
}
