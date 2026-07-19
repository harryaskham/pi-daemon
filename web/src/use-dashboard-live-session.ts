import { useEffect, useMemo, useState } from "react";
import type { DashboardBackend, DashboardControllerRole, DashboardCursor } from "@harryaskham/pi-daemon/dashboard-contract";
import {
  DashboardLiveSessionController,
  type DashboardLiveSessionState,
} from "./dashboard-live-session";

export function useDashboardLiveSession(
  backend: DashboardBackend,
  inventoryId: string,
  role: DashboardControllerRole = "controller",
  onSeen?: (cursor: DashboardCursor) => void,
  initialManaged?: { sessionId: string; generation: number },
): {
  controller: DashboardLiveSessionController;
  state: DashboardLiveSessionState;
} {
  const controller = useMemo(
    () => new DashboardLiveSessionController(backend, inventoryId, {
      role,
      ...(onSeen === undefined ? {} : { onSeen }),
      ...(initialManaged === undefined ? {} : { initialManaged }),
    }),
    [backend, initialManaged?.generation, initialManaged?.sessionId, inventoryId, onSeen, role],
  );
  const [state, setState] = useState(controller.state);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.start();
    return () => {
      unsubscribe();
      void controller.stop();
    };
  }, [controller]);

  return { controller, state };
}
