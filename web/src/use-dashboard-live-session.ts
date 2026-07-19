import { useEffect, useMemo, useState } from "react";
import type { DashboardBackend, DashboardControllerRole } from "@harryaskham/pi-daemon/dashboard-contract";
import {
  DashboardLiveSessionController,
  type DashboardLiveSessionState,
} from "./dashboard-live-session";

export function useDashboardLiveSession(
  backend: DashboardBackend,
  inventoryId: string,
  role: DashboardControllerRole = "controller",
): {
  controller: DashboardLiveSessionController;
  state: DashboardLiveSessionState;
} {
  const controller = useMemo(
    () => new DashboardLiveSessionController(backend, inventoryId, { role }),
    [backend, inventoryId, role],
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
