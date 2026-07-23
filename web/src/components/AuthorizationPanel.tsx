import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  DashboardAuthorizationAuditResource,
  DashboardAuthorizationPolicyResource,
  DashboardControllerState,
  DashboardWorkspaceAccessList,
} from "@harryaskham/pi-daemon/dashboard-authorization-contract";
import type { DashboardResourceRole } from "@harryaskham/pi-daemon/dashboard-authorization";
import { X } from "../icons";
import { BrowserDashboardClient } from "../browser-dashboard-client";

interface AuthorizationPanelProps {
  open: boolean;
  client: BrowserDashboardClient;
  workspaceId: string;
  selectedInventoryId?: string;
  onClose(): void;
}

type TargetKind = "workspace" | "session";

export function AuthorizationPanel({
  open,
  client,
  workspaceId,
  selectedInventoryId,
  onClose,
}: AuthorizationPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<TargetKind>("workspace");
  const resourceId = kind === "workspace" ? workspaceId : selectedInventoryId;
  const [policyResource, setPolicyResource] = useState<DashboardAuthorizationPolicyResource>();
  const [audit, setAudit] = useState<DashboardAuthorizationAuditResource>();
  const [controller, setController] = useState<DashboardControllerState>();
  const [workspaces, setWorkspaces] = useState<DashboardWorkspaceAccessList>();
  const [identityId, setIdentityId] = useState("");
  const [role, setRole] = useState<DashboardResourceRole>("read");
  const [newOwnerIdentityId, setNewOwnerIdentityId] = useState("");
  const [previousOwnerRole, setPreviousOwnerRole] = useState<"none" | DashboardResourceRole>("none");
  const [status, setStatus] = useState("Select a resource to inspect access.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void client.listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces(undefined));
  }, [client, open, workspaceId]);

  useEffect(() => {
    if (!open || resourceId === undefined) {
      setPolicyResource(undefined);
      setAudit(undefined);
      setController(undefined);
      return;
    }
    let cancelled = false;
    setStatus("Loading authorization policy…");
    void Promise.all([
      client.getAuthorization(kind, resourceId),
      client.getAuthorizationAudit(kind, resourceId, 0, 50),
      kind === "session" ? client.getControllerState(kind, resourceId) : Promise.resolve(undefined),
    ]).then(([nextPolicy, nextAudit, nextController]) => {
      if (cancelled) return;
      setPolicyResource(nextPolicy);
      setAudit(nextAudit);
      setController(nextController);
      setStatus("Authorization policy is current.");
    }).catch(() => {
      if (cancelled) return;
      setPolicyResource(undefined);
      setAudit(undefined);
      setController(undefined);
      setStatus("This resource is unavailable or you are not its administrator.");
    });
    return () => { cancelled = true; };
  }, [client, kind, open, resourceId]);

  const grants = policyResource?.policy.grants ?? [];
  const targetLabel = useMemo(() =>
    kind === "workspace" ? `Workspace ${workspaceId}` : resourceId === undefined ? "No session selected" : `Session ${resourceId}`,
  [kind, resourceId, workspaceId]);

  async function refresh(): Promise<void> {
    if (resourceId === undefined) return;
    const [nextPolicy, nextAudit, nextController] = await Promise.all([
      client.getAuthorization(kind, resourceId),
      client.getAuthorizationAudit(kind, resourceId, 0, 50),
      kind === "session" ? client.getControllerState(kind, resourceId) : Promise.resolve(undefined),
    ]);
    setPolicyResource(nextPolicy);
    setAudit(nextAudit);
    setController(nextController);
  }

  async function mutate(operation: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true);
    setStatus("Applying revisioned authorization mutation…");
    try {
      await operation();
      await refresh();
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authorization mutation failed.");
    } finally {
      setBusy(false);
    }
  }

  function submitGrant(event: FormEvent): void {
    event.preventDefault();
    if (resourceId === undefined || policyResource === undefined || identityId.length === 0) return;
    const requestId = `grant-${crypto.randomUUID()}`;
    void mutate(
      () => client.setAuthorizationGrant(kind, resourceId, identityId, policyResource.policy, {
        requestId,
        idempotencyKey: requestId,
        expectedRevision: policyResource.policy.revision,
        role,
      }),
      `Granted ${role} to ${identityId}.`,
    );
  }

  function revoke(identity: string): void {
    if (resourceId === undefined || policyResource === undefined) return;
    const requestId = `revoke-${crypto.randomUUID()}`;
    void mutate(
      () => client.revokeAuthorizationGrant(kind, resourceId, identity, policyResource.policy, {
        requestId,
        idempotencyKey: requestId,
        expectedRevision: policyResource.policy.revision,
      }),
      `Revoked ${identity}.`,
    );
  }

  function transferOwnership(event: FormEvent): void {
    event.preventDefault();
    if (resourceId === undefined || policyResource === undefined || newOwnerIdentityId.length === 0) return;
    const requestId = `owner-${crypto.randomUUID()}`;
    void mutate(
      () => client.transferAuthorizationOwnership(kind, resourceId, policyResource.policy, {
        requestId,
        idempotencyKey: requestId,
        expectedRevision: policyResource.policy.revision,
        newOwnerIdentityId,
        ...(previousOwnerRole === "none" ? {} : { previousOwnerRole }),
      }),
      `Transferred ownership to ${newOwnerIdentityId}.`,
    );
  }

  function transferController(identity: string, participantId: string): void {
    if (resourceId === undefined || policyResource === undefined || controller === undefined) return;
    const requestId = `controller-${crypto.randomUUID()}`;
    void mutate(
      () => client.transferController(kind, resourceId, policyResource.policy.resource, {
        requestId,
        idempotencyKey: requestId,
        expectedRevision: policyResource.policy.revision,
        expectedControllerRevision: controller.revision,
        targetIdentityId: identity,
        targetParticipantId: participantId,
      }),
      `Controller handed to ${identity}.`,
    );
  }

  return (
    <dialog ref={dialogRef} className="settings-dialog access-dialog" aria-labelledby="access-dialog-title" onCancel={onClose} onClose={onClose}>
      <div className="settings-dialog__topbar">
        <div><div><p className="eyebrow">Multi-user policy</p><h2 id="access-dialog-title">Access &amp; controller</h2></div></div>
        <button type="button" onClick={onClose} aria-label="Close access administration"><X size={18} /></button>
      </div>
      <div className="access-layout">
        <section className="access-resource-picker" aria-label="Authorization resource">
          <div className="segmented-control" role="group" aria-label="Resource kind">
            <button type="button" className={kind === "workspace" ? "is-active" : ""} onClick={() => setKind("workspace")}>Workspace</button>
            <button type="button" disabled={selectedInventoryId === undefined} className={kind === "session" ? "is-active" : ""} onClick={() => setKind("session")}>Selected session</button>
          </div>
          <strong>{targetLabel}</strong>
          <p aria-live="polite">{status}</p>
        </section>

        {workspaces !== undefined ? <section>
          <h3>Available workspaces</h3>
          <div className="access-list">{workspaces.workspaces.map((entry) => <div key={entry.workspace.workspaceId}>
            <span><strong>{entry.workspace.workspaceId}</strong><small>{entry.role} · revision {entry.workspace.revision}</small></span>
            {entry.workspace.workspaceId === workspaceId ? <em>Current</em> : <button type="button" onClick={() => void client.selectWorkspace(entry.workspace.workspaceId).then(() => window.location.reload())}>Open</button>}
          </div>)}</div>
          {workspaces.truncated ? <p>Additional authorized workspaces were omitted by the response bound.</p> : null}
        </section> : null}

        {policyResource !== undefined ? <>
          <section>
            <h3>Owner and grants</h3>
            <p>Owner <code>{policyResource.policy.ownerIdentityId}</code> · policy revision {policyResource.policy.revision}</p>
            <div className="access-list">{grants.length === 0 ? <p>No explicit grants.</p> : grants.map((grant) => <div key={grant.identityId}>
              <span><strong>{grant.identityId}</strong><small>{grant.role}</small></span>
              <button type="button" disabled={busy} onClick={() => revoke(grant.identityId)}>Revoke</button>
            </div>)}</div>
            <form className="access-form" onSubmit={submitGrant}>
              <label>Identity ID<input required value={identityId} onChange={(event) => setIdentityId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" /></label>
              <label>Role<select value={role} onChange={(event) => setRole(event.target.value as DashboardResourceRole)}><option value="read">Read</option><option value="control">Control</option><option value="admin">Admin</option></select></label>
              <button type="submit" className="primary-button" disabled={busy}>Set grant</button>
            </form>
          </section>
          <section>
            <h3>Transfer ownership</h3>
            <p>The old owner loses implicit admin before the new owner becomes authoritative.</p>
            <form className="access-form" onSubmit={transferOwnership}>
              <label>New owner ID<input required value={newOwnerIdentityId} onChange={(event) => setNewOwnerIdentityId(event.target.value)} /></label>
              <label>Retain old owner as<select value={previousOwnerRole} onChange={(event) => setPreviousOwnerRole(event.target.value as typeof previousOwnerRole)}><option value="none">No access</option><option value="read">Read</option><option value="control">Control</option><option value="admin">Admin</option></select></label>
              <button type="submit" className="secondary-button" disabled={busy}>Transfer owner</button>
            </form>
          </section>
        </> : null}

        {kind === "session" && controller !== undefined ? <section>
          <h3>Explicit controller handoff</h3>
          <p>Controller revision {controller.revision} · current {controller.controllerIdentityId ?? "none"}. The old controller is released before the target is granted.</p>
          <div className="access-list">{controller.participants.map((participant) => <div key={participant.participantId}>
            <span><strong>{participant.identityId}</strong><small>{participant.presentation} · {participant.role}</small></span>
            <button type="button" disabled={busy || participant.role === "controller"} onClick={() => transferController(participant.identityId, participant.participantId)}>Hand off</button>
          </div>)}</div>
        </section> : null}

        {audit !== undefined ? <section>
          <h3>Content-free audit</h3>
          <ol className="access-audit">{audit.events.map((event) => <li key={event.eventId}><time>{event.occurredAt}</time> <strong>{event.action}</strong> by {event.actorIdentityId}{event.subjectIdentityId === undefined ? "" : ` → ${event.subjectIdentityId}`}</li>)}</ol>
        </section> : null}
      </div>
      <footer><span>All mutations require CSRF, exact ETags and retained idempotency keys.</span><button type="button" className="primary-button" onClick={onClose}>Done</button></footer>
    </dialog>
  );
}
