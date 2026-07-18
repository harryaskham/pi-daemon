import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  DashboardSettingsResource,
  DashboardUiSettingsPatch,
  DashboardWorkspaceResource,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { fromDashboardLayout, toDashboardLayout } from "./layout";
import type { LayoutNode } from "./model";
import {
  DashboardRevisionConflict,
  LocalDashboardPreferencesBackend,
  type DashboardPreferencesBackend,
} from "./preferences-backend";

export type PreferenceSyncState = "synced" | "dirty" | "saving" | "conflict" | "error";

function workspaceKey(layout: LayoutNode, selectedPaneId: string): string {
  return JSON.stringify({ layout: toDashboardLayout(layout), selectedPaneId });
}

export function useDashboardWorkspace(
  backend: DashboardPreferencesBackend,
  initial: DashboardWorkspaceResource,
): {
  resource: DashboardWorkspaceResource;
  layout: LayoutNode;
  setLayout: Dispatch<SetStateAction<LayoutNode>>;
  selectedPaneId: string;
  setSelectedPaneId: Dispatch<SetStateAction<string>>;
  syncState: PreferenceSyncState;
} {
  const [resource, setResource] = useState(initial);
  const [layout, setLayout] = useState(() => fromDashboardLayout(initial.layout));
  const [selectedPaneId, setSelectedPaneId] = useState(initial.selectedPaneId);
  const [syncState, setSyncState] = useState<PreferenceSyncState>("synced");
  const revisionRef = useRef(initial.revision);
  const savedKeyRef = useRef(workspaceKey(layout, selectedPaneId));
  const sequenceRef = useRef(0);
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const key = workspaceKey(layout, selectedPaneId);
    if (key === savedKeyRef.current) return;
    setSyncState("dirty");
    const timer = window.setTimeout(() => {
      const requestSequence = ++sequenceRef.current;
      const wireLayout = toDashboardLayout(layout);
      setSyncState("saving");
      tailRef.current = tailRef.current.then(async () => {
        try {
          const saved = await backend.updateWorkspace({
            requestId: `workspace-request-${requestSequence}`,
            idempotencyKey: `workspace-save-${requestSequence}`,
            expectedRevision: revisionRef.current,
            selectedPaneId,
            layout: wireLayout,
            seenCursors: resource.seenCursors,
          });
          revisionRef.current = saved.revision;
          savedKeyRef.current = key;
          setResource(saved);
          setSyncState("synced");
        } catch (error) {
          if (error instanceof DashboardRevisionConflict) {
            const fresh = await backend.getWorkspace(resource.workspaceId);
            revisionRef.current = fresh.revision;
            const freshLayout = fromDashboardLayout(fresh.layout);
            savedKeyRef.current = workspaceKey(freshLayout, fresh.selectedPaneId);
            setResource(fresh);
            setLayout(freshLayout);
            setSelectedPaneId(fresh.selectedPaneId);
            setSyncState("conflict");
          } else {
            setSyncState("error");
          }
        }
      });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [backend, layout, resource.seenCursors, resource.workspaceId, selectedPaneId]);

  return { resource, layout, setLayout, selectedPaneId, setSelectedPaneId, syncState };
}

export function useDashboardSettings(
  backend: DashboardPreferencesBackend,
  initial: DashboardSettingsResource,
): {
  resource: DashboardSettingsResource;
  syncState: PreferenceSyncState;
  patch(patch: DashboardUiSettingsPatch): void;
  reset(): void;
} {
  const [resource, setResource] = useState(initial);
  const [syncState, setSyncState] = useState<PreferenceSyncState>("synced");
  const revisionRef = useRef(initial.revision);
  const sequenceRef = useRef(0);
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  const recover = useCallback(async (error: unknown) => {
    if (error instanceof DashboardRevisionConflict) {
      const fresh = await backend.getSettings();
      revisionRef.current = fresh.revision;
      setResource(fresh);
      setSyncState("conflict");
    } else {
      setSyncState("error");
    }
  }, [backend]);

  const patch = useCallback((settingsPatch: DashboardUiSettingsPatch) => {
    const requestSequence = ++sequenceRef.current;
    setSyncState("saving");
    tailRef.current = tailRef.current.then(async () => {
      try {
        const saved = await backend.patchSettings({
          requestId: `settings-request-${requestSequence}`,
          idempotencyKey: `settings-patch-${requestSequence}`,
          expectedRevision: revisionRef.current,
          patch: settingsPatch,
        });
        revisionRef.current = saved.revision;
        setResource(saved);
        setSyncState("synced");
      } catch (error) {
        await recover(error);
      }
    });
  }, [backend, recover]);

  const reset = useCallback(() => {
    setSyncState("saving");
    tailRef.current = tailRef.current.then(async () => {
      try {
        const saved = await backend.resetSettings(revisionRef.current);
        revisionRef.current = saved.revision;
        setResource(saved);
        setSyncState("synced");
      } catch (error) {
        await recover(error);
      }
    });
  }, [backend, recover]);

  return { resource, syncState, patch, reset };
}

export function createLocalPreferencesBackend(
  workspace: DashboardWorkspaceResource,
  settings: DashboardSettingsResource,
): LocalDashboardPreferencesBackend {
  return new LocalDashboardPreferencesBackend(workspace, settings);
}
