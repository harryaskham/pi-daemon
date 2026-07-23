import { randomUUID } from "node:crypto";

import {
  asDashboardCursor,
  type DashboardBackend,
  type DashboardCursor,
  type SessionInfoResource,
  type SessionInventoryPage,
  type SessionInventoryQuery,
  type SessionInventoryRecord,
} from "./dashboard-contract.js";
import {
  DashboardAuthorizationError,
  DashboardAuthorizationService,
  type DashboardResourceKind,
  type DashboardResourcePolicy,
  type DashboardResourceRef,
  type DashboardResourceRole,
} from "./dashboard-authorization.js";
import type { DashboardPrincipal } from "./dashboard-identity.js";

const DEFAULT_MAX_SCAN_PAGES = 8;
const DEFAULT_MAX_CURSORS = 1_024;
const DEFAULT_CURSOR_TTL_MS = 15 * 60_000;

export interface DashboardAuthorizationEnforcerOptions {
  backend: DashboardBackend;
  authorization: DashboardAuthorizationService;
  maxInventoryPageItems: number;
  maxScanPages?: number;
  maxCursors?: number;
  cursorTtlMs?: number;
  now?: () => number;
}

export interface AuthorizedDashboardSession {
  resource: DashboardResourceRef;
  role: DashboardResourceRole;
  info: SessionInfoResource;
}

interface InventoryCursorRecord {
  principalId: string;
  queryFingerprint: string;
  backendCursor?: DashboardCursor;
  bufferedSessions: SessionInventoryRecord[];
  index: SessionInventoryPage["index"];
  expiresAt: number;
}

/**
 * Browser-bound enforcement adapter. It is deliberately outside every
 * DashboardBackend: the dedicated backend may continue to use only the
 * machine service bearer while this adapter resolves browser references and
 * consults the one central policy ledger before any backend operation.
 */
export class DashboardAuthorizationEnforcer {
  readonly backend: DashboardBackend;
  readonly authorization: DashboardAuthorizationService;
  readonly maxInventoryPageItems: number;
  readonly maxScanPages: number;
  readonly maxCursors: number;
  readonly cursorTtlMs: number;
  readonly #now: () => number;
  readonly #inventoryCursors = new Map<string, InventoryCursorRecord>();

  constructor(options: DashboardAuthorizationEnforcerOptions) {
    this.backend = options.backend;
    this.authorization = options.authorization;
    this.maxInventoryPageItems = positiveInteger(
      options.maxInventoryPageItems,
      "maxInventoryPageItems",
    );
    this.maxScanPages = positiveInteger(
      options.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES,
      "maxScanPages",
    );
    this.maxCursors = positiveInteger(options.maxCursors ?? DEFAULT_MAX_CURSORS, "maxCursors");
    this.cursorTtlMs = positiveInteger(
      options.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS,
      "cursorTtlMs",
    );
    this.#now = options.now ?? Date.now;
  }

  initialize(): Promise<void> {
    return this.authorization.initialize();
  }

  effectiveRole(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
  ): Promise<DashboardResourceRole | undefined> {
    return this.authorization.effectiveRole(principal, resource);
  }

  async require(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
    role: DashboardResourceRole,
  ): Promise<DashboardResourceRole> {
    return this.authorization.require(principal, resource, role);
  }

  async registerCreated(
    principal: DashboardPrincipal,
    kind: DashboardResourceKind,
    id: string,
  ): Promise<DashboardResourcePolicy> {
    try {
      return await this.authorization.registerCreatedResource(principal, { kind, id });
    } catch (error) {
      if (
        error instanceof DashboardAuthorizationError &&
        error.code === "authorization_resource_conflict"
      ) {
        throw hiddenResourceError();
      }
      throw error;
    }
  }

  async registerInventorySession(
    principal: DashboardPrincipal,
    inventoryId: string,
  ): Promise<DashboardResourcePolicy> {
    const policy = await this.registerInventorySessionIfPresent(principal, inventoryId);
    if (policy === undefined) throw hiddenResourceError();
    return policy;
  }

  async registerInventorySessionIfPresent(
    principal: DashboardPrincipal,
    inventoryId: string,
  ): Promise<DashboardResourcePolicy | undefined> {
    let info: SessionInfoResource;
    try {
      info = await this.backend.getSessionInfo(inventoryId);
    } catch (error) {
      if (isBackendNotFound(error)) return undefined;
      throw error;
    }
    const resource = primarySessionRef(info);
    return this.registerCreated(principal, resource.kind, resource.id);
  }

  async requireInventorySession(
    principal: DashboardPrincipal,
    inventoryId: string,
    requiredRole: DashboardResourceRole,
  ): Promise<AuthorizedDashboardSession> {
    let info: SessionInfoResource;
    try {
      info = await this.backend.getSessionInfo(inventoryId);
    } catch (error) {
      if (isBackendNotFound(error)) throw hiddenResourceError();
      throw error;
    }
    const decision = await this.#requireAny(
      principal,
      sessionRefs(info),
      requiredRole,
    );
    return { ...decision, info };
  }

  async requireManagedSession(
    principal: DashboardPrincipal,
    sessionRef: string,
    requiredRole: DashboardResourceRole,
  ): Promise<{ resource: DashboardResourceRef; role: DashboardResourceRole }> {
    const resource = managedSessionRef(sessionRef);
    const role = await this.authorization.require(principal, resource, requiredRole);
    try {
      await this.backend.getManagedSession(sessionRef);
    } catch (error) {
      if (isBackendNotFound(error)) throw hiddenResourceError();
      throw error;
    }
    return { resource, role };
  }

  async listSessions(
    principal: DashboardPrincipal,
    query: SessionInventoryQuery,
  ): Promise<SessionInventoryPage> {
    const now = this.#now();
    this.#pruneCursors(now);
    const fingerprint = inventoryQueryFingerprint(query);
    let backendCursor: DashboardCursor | undefined;
    let backendExhausted = false;
    let cursorIndex: SessionInventoryPage["index"] | undefined;
    let sessions: SessionInventoryRecord[] = [];
    if (query.cursor !== undefined) {
      const cursor = this.#inventoryCursors.get(query.cursor);
      if (
        cursor === undefined ||
        cursor.expiresAt <= now ||
        cursor.principalId !== principal.identityId ||
        cursor.queryFingerprint !== fingerprint
      ) {
        throw new DashboardAuthorizationError(
          "inventory_cursor_invalid",
          "dashboard inventory cursor is invalid",
          400,
        );
      }
      backendCursor = cursor.backendCursor;
      backendExhausted = cursor.backendCursor === undefined;
      cursorIndex = structuredClone(cursor.index);
      sessions = structuredClone(cursor.bufferedSessions);
    }

    const limit = Math.min(query.limit ?? this.maxInventoryPageItems, this.maxInventoryPageItems);
    const target = limit + 1;
    const { cursor: _browserCursor, ...backendQuery } = query;
    let lastPage: SessionInventoryPage | undefined;
    let scans = 0;
    while (
      sessions.length < target &&
      scans < this.maxScanPages &&
      !backendExhausted
    ) {
      const page = await this.backend.listSessions({
        ...backendQuery,
        limit: Math.min(
          this.maxInventoryPageItems,
          Math.max(1, target - sessions.length),
        ),
        ...(backendCursor === undefined ? {} : { cursor: backendCursor }),
      });
      lastPage = page;
      scans += 1;
      const authorized = await Promise.all(
        page.sessions.map(async (record) =>
          (await this.#effectiveAny(principal, sessionRefs(record), "read")) === undefined
            ? undefined
            : record,
        ),
      );
      sessions.push(
        ...authorized.filter((record): record is SessionInventoryRecord => record !== undefined),
      );
      backendCursor = page.nextCursor;
      backendExhausted = backendCursor === undefined || page.sessions.length === 0;
    }

    if (lastPage === undefined && query.cursor === undefined) {
      throw new Error("dashboard inventory backend returned no page");
    }
    const visible = sessions.slice(0, limit);
    const bufferedSessions = sessions.slice(limit, target);
    const nextCursor = bufferedSessions.length === 0
      ? undefined
      : this.#storeCursor(
          principal.identityId,
          fingerprint,
          backendCursor,
          bufferedSessions,
          lastPage?.index ?? cursorIndex!,
          now,
        );
    return {
      sessions: visible,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      index: structuredClone(lastPage?.index ?? cursorIndex!),
    };
  }

  async #requireAny(
    principal: DashboardPrincipal,
    resources: readonly DashboardResourceRef[],
    requiredRole: DashboardResourceRole,
  ): Promise<{ resource: DashboardResourceRef; role: DashboardResourceRole }> {
    const result = await this.#effectiveAny(principal, resources, requiredRole);
    if (result === undefined) throw hiddenResourceError();
    return result;
  }

  async #effectiveAny(
    principal: DashboardPrincipal,
    resources: readonly DashboardResourceRef[],
    requiredRole: DashboardResourceRole,
  ): Promise<{ resource: DashboardResourceRef; role: DashboardResourceRole } | undefined> {
    let best: { resource: DashboardResourceRef; role: DashboardResourceRole } | undefined;
    for (const resource of deduplicateRefs(resources)) {
      const role = await this.authorization.effectiveRole(principal, resource);
      if (role === undefined || roleRank(role) < roleRank(requiredRole)) continue;
      if (best === undefined || roleRank(role) > roleRank(best.role)) best = { resource, role };
    }
    return best;
  }

  #storeCursor(
    principalId: string,
    queryFingerprint: string,
    backendCursor: DashboardCursor | undefined,
    bufferedSessions: SessionInventoryRecord[],
    index: SessionInventoryPage["index"],
    now: number,
  ): DashboardCursor {
    while (this.#inventoryCursors.size >= this.maxCursors) {
      const oldest = this.#inventoryCursors.keys().next().value;
      if (oldest === undefined) break;
      this.#inventoryCursors.delete(oldest);
    }
    const token = asDashboardCursor(`authorized-inventory:${randomUUID()}`);
    this.#inventoryCursors.set(token, {
      principalId,
      queryFingerprint,
      ...(backendCursor === undefined ? {} : { backendCursor }),
      bufferedSessions: structuredClone(bufferedSessions),
      index: structuredClone(index),
      expiresAt: now + this.cursorTtlMs,
    });
    return token;
  }

  #pruneCursors(now: number): void {
    for (const [token, cursor] of this.#inventoryCursors) {
      if (cursor.expiresAt <= now) this.#inventoryCursors.delete(token);
    }
  }
}

export function workspaceResource(workspaceId: string): DashboardResourceRef {
  return { kind: "workspace", id: workspaceId };
}

export function draftResource(draftId: string): DashboardResourceRef {
  return { kind: "draft", id: draftId };
}

export function draftTicketResource(ticketId: string): DashboardResourceRef {
  return { kind: "draft-ticket", id: ticketId };
}

export function activationTicketResource(ticketId: string): DashboardResourceRef {
  return { kind: "activation-ticket", id: ticketId };
}

export function exportTicketResource(ticketId: string): DashboardResourceRef {
  return { kind: "export-ticket", id: ticketId };
}

export function scheduleResource(scheduleId: string): DashboardResourceRef {
  return { kind: "schedule", id: scheduleId };
}

export function managedSessionRef(sessionId: string): DashboardResourceRef {
  return { kind: "session", id: prefixedResourceId("managed", sessionId) };
}

export function sessionRefs(
  session: SessionInventoryRecord | SessionInfoResource,
): DashboardResourceRef[] {
  if (session.managed !== undefined) return [managedSessionRef(session.managed.sessionId)];
  if (session.piSessionId !== undefined) {
    return [{ kind: "session", id: prefixedResourceId("pi", session.piSessionId) }];
  }
  const inventoryIds = [session.inventoryId];
  if ("source" in session) {
    inventoryIds.push(...session.source.aliases.map(({ inventoryId }) => inventoryId));
    if (session.ownership.sourceInventoryId !== undefined) {
      inventoryIds.push(session.ownership.sourceInventoryId);
    }
  }
  inventoryIds.sort((left, right) => left.localeCompare(right));
  return [{ kind: "session", id: prefixedResourceId("inventory", inventoryIds[0]!) }];
}

export function primarySessionRef(
  session: SessionInventoryRecord | SessionInfoResource,
): DashboardResourceRef {
  return sessionRefs(session)[0]!;
}

function prefixedResourceId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

function deduplicateRefs(resources: readonly DashboardResourceRef[]): DashboardResourceRef[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.kind}\u0000${resource.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inventoryQueryFingerprint(query: SessionInventoryQuery): string {
  return JSON.stringify({
    search: query.search ?? null,
    sourceKinds: query.sourceKinds ?? null,
    runtime: query.runtime ?? null,
    unread: query.unread ?? null,
    modifiedAfter: query.modifiedAfter ?? null,
  });
}

function roleRank(role: DashboardResourceRole): number {
  return role === "read" ? 1 : role === "control" ? 2 : 3;
}

function hiddenResourceError(): DashboardAuthorizationError {
  return new DashboardAuthorizationError(
    "not_found",
    "dashboard resource was not found",
    404,
  );
}

function isBackendNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.includes("not_found")
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
