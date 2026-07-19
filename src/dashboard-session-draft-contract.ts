export type {
  DashboardSessionDraftCancelRequest,
  DashboardSessionDraftCreateRequest,
  DashboardSessionDraftExecution,
  DashboardSessionDraftIdentity,
  DashboardSessionDraftMaterialization,
  DashboardSessionDraftPrivatePhase,
  DashboardSessionDraftRecovery,
  DashboardSessionDraftResource,
  DashboardSessionDraftSendRequest,
  DashboardSessionDraftSendTicket,
  DashboardSessionDraftSendWork,
  DashboardSessionDraftSpec,
  DashboardSessionDraftState,
  DashboardSessionDraftTicketState,
  DashboardSessionDraftTransition,
} from "./dashboard-session-drafts.js";

/** Browser/Node-stable optimistic-concurrency tag for one draft revision. */
export function dashboardSessionDraftEtag(draftId: string, revision: number): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(draftId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("invalid dashboard session draft identity");
  }
  const bytes = new TextEncoder().encode(draftId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  return `"${encoded}:${revision}"`;
}
