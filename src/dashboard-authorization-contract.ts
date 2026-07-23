import type {
  DashboardAuthorizationAuditEvent,
  DashboardResourcePolicy,
  DashboardResourceRef,
  DashboardResourceRole,
} from "./dashboard-authorization.js";
import type { DashboardWorkspaceResource } from "./dashboard-contract.js";

export interface DashboardAuthorizationMutationRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision: number;
}

export interface DashboardGrantSetRequest extends DashboardAuthorizationMutationRequest {
  role: DashboardResourceRole;
}

export type DashboardGrantRevokeRequest = DashboardAuthorizationMutationRequest;

export interface DashboardOwnershipTransferRequest extends DashboardAuthorizationMutationRequest {
  newOwnerIdentityId: string;
  previousOwnerRole?: DashboardResourceRole;
}

export interface DashboardAuthorizationPolicyResource {
  policy: DashboardResourcePolicy;
  role: "admin";
}

export interface DashboardAuthorizationAuditResource {
  events: DashboardAuthorizationAuditEvent[];
  droppedEvents: number;
  nextSequence: number;
}

export interface DashboardWorkspaceAccessEntry {
  workspace: DashboardWorkspaceResource;
  policy: DashboardResourcePolicy;
  role: DashboardResourceRole;
}

export interface DashboardWorkspaceAccessList {
  workspaces: DashboardWorkspaceAccessEntry[];
  truncated: boolean;
}

export interface DashboardWorkspaceSelectionRequest {
  requestId: string;
  workspaceId: string;
}

export interface DashboardControllerParticipant {
  participantId: string;
  identityId: string;
  presentation: "rich" | "tui";
  role: "observer" | "controller";
}

export interface DashboardControllerState {
  resource: DashboardResourceRef;
  revision: number;
  controllerIdentityId?: string;
  participants: DashboardControllerParticipant[];
}

export interface DashboardControllerTransferRequest extends DashboardAuthorizationMutationRequest {
  expectedControllerRevision: number;
  targetIdentityId: string;
  targetParticipantId?: string;
}

export interface DashboardControllerTransferResource {
  policy: DashboardResourcePolicy;
  controller: DashboardControllerState;
}

export function dashboardAuthorizationPolicyEtag(policy: DashboardResourcePolicy): string {
  return `"dashboard-authorization:${policy.resource.kind}:${policy.resource.id}:${policy.revision}"`;
}

export function dashboardControllerEtag(resource: DashboardResourceRef, revision: number): string {
  return `"dashboard-controller:${resource.kind}:${resource.id}:${revision}"`;
}
