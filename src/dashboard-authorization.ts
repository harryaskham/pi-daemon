import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DASHBOARD_LOCAL_OWNER_ID,
  validateDashboardIdentityId,
  type DashboardPrincipal,
} from "./dashboard-identity.js";

const AUTHORIZATION_FORMAT_VERSION = 1 as const;
export const DEFAULT_DASHBOARD_AUTHORIZATION_MAX_POLICIES = 20_000;
export const DEFAULT_DASHBOARD_AUTHORIZATION_MAX_GRANTS_PER_POLICY = 64;
export const DEFAULT_DASHBOARD_AUTHORIZATION_MAX_AUDIT_EVENTS = 10_000;
export const DEFAULT_DASHBOARD_AUTHORIZATION_MAX_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_ID_BYTES = 256;
const MAX_READ_SLACK_BYTES = 1;
const MAX_IDEMPOTENCY_RECEIPTS = 1_024;

export type DashboardAuthorizationMode = "single-owner" | "multi-user";
export type DashboardResourceKind =
  | "session"
  | "workspace"
  | "draft"
  | "draft-ticket"
  | "activation-ticket"
  | "export-ticket"
  | "schedule";
export type DashboardResourceRole = "read" | "control" | "admin";

export interface DashboardResourceRef {
  kind: DashboardResourceKind;
  id: string;
}

export interface DashboardResourceGrant {
  identityId: string;
  role: DashboardResourceRole;
}

export interface DashboardResourcePolicy {
  resource: DashboardResourceRef;
  ownerIdentityId: string;
  grants: DashboardResourceGrant[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type DashboardAuthorizationAuditAction =
  | "resource-created"
  | "resource-adopted"
  | "grant-set"
  | "grant-revoked"
  | "ownership-transferred"
  | "controller-transferred";

export interface DashboardAuthorizationAuditEvent {
  sequence: number;
  eventId: string;
  occurredAt: string;
  actorIdentityId: string;
  action: DashboardAuthorizationAuditAction;
  resource: DashboardResourceRef;
  subjectIdentityId?: string;
  role?: DashboardResourceRole;
  previousOwnerIdentityId?: string;
  previousControllerIdentityId?: string;
}

interface DashboardAuthorizationIdempotencyReceipt {
  actorIdentityId: string;
  key: string;
  fingerprint: string;
  result: DashboardResourcePolicy;
}

type PendingIdempotencyReceipt = Omit<DashboardAuthorizationIdempotencyReceipt, "result">;

interface DashboardAuthorizationState {
  formatVersion: typeof AUTHORIZATION_FORMAT_VERSION;
  revision: number;
  nextAuditSequence: number;
  droppedAuditEvents: number;
  policies: DashboardResourcePolicy[];
  audit: DashboardAuthorizationAuditEvent[];
  idempotency: DashboardAuthorizationIdempotencyReceipt[];
}

export interface DashboardAuthorizationLimits {
  maxPolicies: number;
  maxGrantsPerPolicy: number;
  maxAuditEvents: number;
  maxBytes: number;
}

export interface DashboardAuthorizationServiceOptions {
  stateDir: string;
  mode?: DashboardAuthorizationMode;
  localOwnerIdentityId?: string;
  limits?: Partial<DashboardAuthorizationLimits>;
  now?: () => Date;
}

export function dashboardAuthorizationEtag(policy: DashboardResourcePolicy): string {
  return `"dashboard-authorization:${policy.resource.kind}:${policy.resource.id}:${policy.revision}"`;
}

export class DashboardAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "DashboardAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Central authorization source for all Dashboard resources. Existing protocol
 * resources deliberately contain no ACL properties; policies and content-free
 * audit facts live in this owner-private ledger instead.
 */
export class DashboardAuthorizationService {
  readonly rootStateDir: string;
  readonly stateDir: string;
  readonly path: string;
  readonly mode: DashboardAuthorizationMode;
  readonly localOwnerIdentityId: string;
  readonly limits: Readonly<DashboardAuthorizationLimits>;
  readonly #now: () => Date;
  #state: DashboardAuthorizationState | undefined;
  #policyIndex = new Map<string, DashboardResourcePolicy>();
  #terminalFailure: DashboardAuthorizationError | undefined;
  #initialization: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DashboardAuthorizationServiceOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.rootStateDir = options.stateDir;
    this.stateDir = join(this.rootStateDir, "web");
    this.path = join(this.stateDir, "authorization-v1.json");
    this.mode = options.mode ?? "single-owner";
    this.localOwnerIdentityId = validateDashboardIdentityId(
      options.localOwnerIdentityId ?? DASHBOARD_LOCAL_OWNER_ID,
    );
    this.limits = Object.freeze(resolveAuthorizationLimits(options.limits));
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    this.#initialization ??= this.#runInitialize();
    await this.#initialization;
  }

  async effectiveRole(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
  ): Promise<DashboardResourceRole | undefined> {
    validatePrincipal(principal);
    const ref = validateResourceRef(resource);
    await this.initialize();
    await this.#tail;
    this.#assertAvailable();
    return this.#effectiveRole(principal, ref);
  }

  async require(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
    requiredRole: DashboardResourceRole,
  ): Promise<DashboardResourceRole> {
    const role = await this.effectiveRole(principal, resource);
    if (role === undefined || roleRank(role) < roleRank(requiredRole)) {
      throw hiddenResourceError();
    }
    return role;
  }

  async listPolicies(
    principal: DashboardPrincipal,
    options: { kind?: DashboardResourceKind; limit?: number } = {},
  ): Promise<{ policies: DashboardResourcePolicy[]; truncated: boolean }> {
    validatePrincipal(principal);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DashboardAuthorizationError("invalid_request", "policy limit is invalid");
    }
    await this.initialize();
    await this.#tail;
    this.#assertAvailable();
    const visible = this.#state!.policies.filter(
      (policy) =>
        (options.kind === undefined || policy.resource.kind === options.kind) &&
        this.#effectiveRole(principal, policy.resource) !== undefined,
    );
    return {
      policies: structuredClone(visible.slice(0, limit)),
      truncated: visible.length > limit,
    };
  }

  async policy(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
  ): Promise<DashboardResourcePolicy> {
    validatePrincipal(principal);
    const ref = validateResourceRef(resource);
    await this.initialize();
    await this.#tail;
    this.#assertAvailable();
    if (this.#effectiveRole(principal, ref) !== "admin") throw hiddenResourceError();
    const policy = this.#policy(ref);
    if (policy === undefined) throw hiddenResourceError();
    return structuredClone(policy);
  }

  /** Register a resource proven by the trusted caller to have just been created. */
  registerCreatedResource(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
  ): Promise<DashboardResourcePolicy> {
    validatePrincipal(principal);
    const ref = validateResourceRef(resource);
    return this.#mutate(async () => {
      const existing = this.#policy(ref);
      if (existing !== undefined) {
        if (existing.ownerIdentityId === principal.identityId) return structuredClone(existing);
        throw new DashboardAuthorizationError(
          "authorization_resource_conflict",
          "authorization resource registration conflicted",
          409,
        );
      }
      return this.#createPolicy(principal.identityId, principal.identityId, ref, "resource-created");
    });
  }

  /** Adopt a pre-existing unowned resource; only a global administrator may do so. */
  adoptResource(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
    ownerIdentityId: string,
  ): Promise<DashboardResourcePolicy> {
    validatePrincipal(principal);
    const ref = validateResourceRef(resource);
    const owner = validateDashboardIdentityId(ownerIdentityId);
    if (principal.globalRole !== "administrator") return Promise.reject(hiddenResourceError());
    return this.#mutate(async () => {
      const existing = this.#policy(ref);
      if (existing !== undefined) {
        if (existing.ownerIdentityId === owner) return structuredClone(existing);
        throw new DashboardAuthorizationError(
          "authorization_resource_conflict",
          "authorization resource registration conflicted",
          409,
        );
      }
      return this.#createPolicy(principal.identityId, owner, ref, "resource-adopted");
    });
  }

  setGrant(options: {
    principal: DashboardPrincipal;
    resource: DashboardResourceRef;
    subjectIdentityId: string;
    role: DashboardResourceRole;
    expectedRevision: number;
    idempotencyKey?: string;
  }): Promise<DashboardResourcePolicy> {
    validatePrincipal(options.principal);
    const ref = validateResourceRef(options.resource);
    const subject = validateDashboardIdentityId(options.subjectIdentityId);
    validateRole(options.role);
    validateRevision(options.expectedRevision);
    const receipt = pendingReceipt(options.principal, options.idempotencyKey, {
      operation: "grant-set",
      resource: ref,
      subjectIdentityId: subject,
      role: options.role,
      expectedRevision: options.expectedRevision,
    });
    return this.#mutate(async () => {
      const replay = this.#replayReceipt(receipt);
      if (replay !== undefined) return replay;
      const policy = await this.#mutableAdminPolicy(options.principal, ref);
      assertExpectedRevision(policy, options.expectedRevision);
      if (subject === policy.ownerIdentityId) {
        throw new DashboardAuthorizationError(
          "authorization_owner_grant_invalid",
          "resource owner access is implicit",
          409,
        );
      }
      const grants = policy.grants.filter(({ identityId }) => identityId !== subject);
      grants.push({ identityId: subject, role: options.role });
      grants.sort((left, right) => left.identityId.localeCompare(right.identityId));
      if (grants.length > this.limits.maxGrantsPerPolicy) {
        throw new DashboardAuthorizationError(
          "authorization_grant_capacity",
          "resource grant capacity is exhausted",
          503,
        );
      }
      return this.#replacePolicy(
        policy,
        { ...policy, grants },
        {
          actorIdentityId: options.principal.identityId,
          action: "grant-set",
          resource: ref,
          subjectIdentityId: subject,
          role: options.role,
        },
        receipt,
      );
    });
  }

  revokeGrant(options: {
    principal: DashboardPrincipal;
    resource: DashboardResourceRef;
    subjectIdentityId: string;
    expectedRevision: number;
    idempotencyKey?: string;
  }): Promise<DashboardResourcePolicy> {
    validatePrincipal(options.principal);
    const ref = validateResourceRef(options.resource);
    const subject = validateDashboardIdentityId(options.subjectIdentityId);
    validateRevision(options.expectedRevision);
    const receipt = pendingReceipt(options.principal, options.idempotencyKey, {
      operation: "grant-revoked",
      resource: ref,
      subjectIdentityId: subject,
      expectedRevision: options.expectedRevision,
    });
    return this.#mutate(async () => {
      const replay = this.#replayReceipt(receipt);
      if (replay !== undefined) return replay;
      const policy = await this.#mutableAdminPolicy(options.principal, ref);
      assertExpectedRevision(policy, options.expectedRevision);
      const grants = policy.grants.filter(({ identityId }) => identityId !== subject);
      if (grants.length === policy.grants.length) {
        return this.#recordReceipt(policy, receipt);
      }
      return this.#replacePolicy(
        policy,
        { ...policy, grants },
        {
          actorIdentityId: options.principal.identityId,
          action: "grant-revoked",
          resource: ref,
          subjectIdentityId: subject,
        },
        receipt,
      );
    });
  }

  transferOwnership(options: {
    principal: DashboardPrincipal;
    resource: DashboardResourceRef;
    newOwnerIdentityId: string;
    previousOwnerRole?: DashboardResourceRole;
    expectedRevision: number;
    idempotencyKey?: string;
  }): Promise<DashboardResourcePolicy> {
    validatePrincipal(options.principal);
    const ref = validateResourceRef(options.resource);
    const nextOwner = validateDashboardIdentityId(options.newOwnerIdentityId);
    if (options.previousOwnerRole !== undefined) validateRole(options.previousOwnerRole);
    validateRevision(options.expectedRevision);
    const receipt = pendingReceipt(options.principal, options.idempotencyKey, {
      operation: "ownership-transferred",
      resource: ref,
      newOwnerIdentityId: nextOwner,
      previousOwnerRole: options.previousOwnerRole ?? null,
      expectedRevision: options.expectedRevision,
    });
    return this.#mutate(async () => {
      const replay = this.#replayReceipt(receipt);
      if (replay !== undefined) return replay;
      const policy = await this.#mutableAdminPolicy(options.principal, ref);
      assertExpectedRevision(policy, options.expectedRevision);
      if (policy.ownerIdentityId === nextOwner) {
        return this.#recordReceipt(policy, receipt);
      }
      const previousOwner = policy.ownerIdentityId;
      const grants = policy.grants.filter(
        ({ identityId }) => identityId !== nextOwner && identityId !== previousOwner,
      );
      if (options.previousOwnerRole !== undefined) {
        grants.push({ identityId: previousOwner, role: options.previousOwnerRole });
      }
      grants.sort((left, right) => left.identityId.localeCompare(right.identityId));
      return this.#replacePolicy(
        policy,
        { ...policy, ownerIdentityId: nextOwner, grants },
        {
          actorIdentityId: options.principal.identityId,
          action: "ownership-transferred",
          resource: ref,
          subjectIdentityId: nextOwner,
          previousOwnerIdentityId: previousOwner,
          ...(options.previousOwnerRole === undefined
            ? {}
            : { role: options.previousOwnerRole }),
        },
        receipt,
      );
    });
  }

  recordControllerTransfer(options: {
    principal: DashboardPrincipal;
    resource: DashboardResourceRef;
    previousControllerIdentityId?: string;
    newControllerIdentityId: string;
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<DashboardResourcePolicy> {
    validatePrincipal(options.principal);
    const ref = validateResourceRef(options.resource);
    const previous = options.previousControllerIdentityId === undefined
      ? undefined
      : validateDashboardIdentityId(options.previousControllerIdentityId);
    const next = validateDashboardIdentityId(options.newControllerIdentityId);
    validateRevision(options.expectedRevision);
    const receipt = pendingReceipt(options.principal, options.idempotencyKey, {
      operation: "controller-transferred",
      resource: ref,
      previousControllerIdentityId: previous ?? null,
      newControllerIdentityId: next,
      expectedRevision: options.expectedRevision,
    })!;
    return this.#mutate(async () => {
      const replay = this.#replayReceipt(receipt);
      if (replay !== undefined) return replay;
      const policy = await this.#mutableAdminPolicy(options.principal, ref);
      assertExpectedRevision(policy, options.expectedRevision);
      const state = this.#state!;
      const timestamp = this.#timestamp();
      state.revision += 1;
      appendAudit(state, this.limits, {
        actorIdentityId: options.principal.identityId,
        action: "controller-transferred",
        resource: ref,
        subjectIdentityId: next,
        ...(previous === undefined ? {} : { previousControllerIdentityId: previous }),
      }, timestamp);
      this.#appendReceipt(receipt, policy);
      await this.#write();
      return structuredClone(policy);
    });
  }

  async auditEvents(
    principal: DashboardPrincipal,
    options: {
      resource?: DashboardResourceRef;
      afterSequence?: number;
      limit?: number;
    } = {},
  ): Promise<{
    events: DashboardAuthorizationAuditEvent[];
    droppedEvents: number;
    nextSequence: number;
  }> {
    validatePrincipal(principal);
    const resource = options.resource === undefined
      ? undefined
      : validateResourceRef(options.resource);
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new DashboardAuthorizationError("invalid_request", "audit cursor is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DashboardAuthorizationError("invalid_request", "audit limit is invalid");
    }
    await this.initialize();
    await this.#tail;
    this.#assertAvailable();
    if (
      resource === undefined
        ? principal.globalRole !== "administrator"
        : this.#effectiveRole(principal, resource) !== "admin"
    ) {
      throw hiddenResourceError();
    }
    const state = this.#state!;
    if (resource !== undefined) {
      // Global audit sequence gaps would reveal otherwise-inaccessible activity.
      // Resource administrators receive a retained-window-relative sequence
      // instead; only global administrators receive global truncation facts.
      const events = state.audit
        .filter((event) => resourceKey(event.resource) === resourceKey(resource))
        .map((event, index) => ({ ...event, sequence: index + 1 }));
      return {
        events: structuredClone(
          events.filter((event) => event.sequence > afterSequence).slice(0, limit),
        ),
        droppedEvents: 0,
        nextSequence: events.length + 1,
      };
    }
    return {
      events: structuredClone(
        state.audit
          .filter((event) => event.sequence > afterSequence)
          .slice(0, limit),
      ),
      droppedEvents: state.droppedAuditEvents,
      nextSequence: state.nextAuditSequence,
    };
  }

  async #runInitialize(): Promise<void> {
    await ensurePrivateDirectory(this.rootStateDir, "dashboard state directory");
    await ensurePrivateDirectory(this.stateDir, "dashboard authorization directory");
    this.#state = await readAuthorizationState(this.path, this.limits);
    this.#reindexPolicies();
  }

  #policy(resource: DashboardResourceRef): DashboardResourcePolicy | undefined {
    return this.#policyIndex.get(resourceKey(resource));
  }

  #reindexPolicies(): void {
    this.#policyIndex = new Map(
      this.#state!.policies.map((policy) => [resourceKey(policy.resource), policy]),
    );
  }

  #effectiveRole(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
  ): DashboardResourceRole | undefined {
    if (principal.globalRole === "administrator") return "admin";
    const policy = this.#policy(resource);
    if (policy === undefined) {
      return this.mode === "single-owner" && principal.identityId === this.localOwnerIdentityId
        ? "admin"
        : undefined;
    }
    if (policy.ownerIdentityId === principal.identityId) return "admin";
    return policy.grants.find(({ identityId }) => identityId === principal.identityId)?.role;
  }

  #mutableAdminPolicy(
    principal: DashboardPrincipal,
    resource: DashboardResourceRef,
  ): DashboardResourcePolicy {
    if (this.#effectiveRole(principal, resource) !== "admin") throw hiddenResourceError();
    const policy = this.#policy(resource);
    if (policy === undefined) throw hiddenResourceError();
    return policy;
  }

  async #createPolicy(
    actorIdentityId: string,
    ownerIdentityId: string,
    resource: DashboardResourceRef,
    action: "resource-created" | "resource-adopted",
  ): Promise<DashboardResourcePolicy> {
    const state = this.#state!;
    if (state.policies.length >= this.limits.maxPolicies) {
      throw new DashboardAuthorizationError(
        "authorization_policy_capacity",
        "authorization policy capacity is exhausted",
        503,
      );
    }
    const timestamp = this.#timestamp();
    const policy: DashboardResourcePolicy = {
      resource,
      ownerIdentityId,
      grants: [],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.policies.push(policy);
    state.policies.sort((left, right) => resourceKey(left.resource).localeCompare(resourceKey(right.resource)));
    this.#policyIndex.set(resourceKey(resource), policy);
    state.revision += 1;
    appendAudit(state, this.limits, {
      actorIdentityId,
      action,
      resource,
      subjectIdentityId: ownerIdentityId,
    }, timestamp);
    await this.#write();
    return structuredClone(policy);
  }

  async #replacePolicy(
    previous: DashboardResourcePolicy,
    next: DashboardResourcePolicy,
    event: Omit<DashboardAuthorizationAuditEvent, "sequence" | "eventId" | "occurredAt">,
    receipt?: PendingIdempotencyReceipt,
  ): Promise<DashboardResourcePolicy> {
    const state = this.#state!;
    const index = state.policies.indexOf(previous);
    if (index < 0) throw new Error("authorization policy disappeared during mutation");
    const timestamp = this.#timestamp();
    const updated: DashboardResourcePolicy = {
      ...next,
      grants: structuredClone(next.grants),
      revision: previous.revision + 1,
      createdAt: previous.createdAt,
      updatedAt: timestamp,
    };
    state.policies[index] = updated;
    this.#policyIndex.set(resourceKey(updated.resource), updated);
    state.revision += 1;
    appendAudit(state, this.limits, event, timestamp);
    this.#appendReceipt(receipt, updated);
    await this.#write();
    return structuredClone(updated);
  }

  async #recordReceipt(
    policy: DashboardResourcePolicy,
    receipt: PendingIdempotencyReceipt | undefined,
  ): Promise<DashboardResourcePolicy> {
    if (receipt === undefined) return structuredClone(policy);
    this.#state!.revision += 1;
    this.#appendReceipt(receipt, policy);
    await this.#write();
    return structuredClone(policy);
  }

  #replayReceipt(
    receipt: PendingIdempotencyReceipt | undefined,
  ): DashboardResourcePolicy | undefined {
    if (receipt === undefined) return undefined;
    const retained = this.#state!.idempotency.find(
      (candidate) =>
        candidate.actorIdentityId === receipt.actorIdentityId &&
        candidate.key === receipt.key,
    );
    if (retained === undefined) return undefined;
    if (retained.fingerprint !== receipt.fingerprint) {
      throw new DashboardAuthorizationError(
        "idempotency_conflict",
        "idempotency key was already used for another authorization mutation",
        409,
      );
    }
    return structuredClone(retained.result);
  }

  #appendReceipt(
    receipt: PendingIdempotencyReceipt | undefined,
    result: DashboardResourcePolicy,
  ): void {
    if (receipt === undefined) return;
    this.#state!.idempotency.push({ ...receipt, result: structuredClone(result) });
    this.#state!.idempotency = this.#state!.idempotency.slice(-MAX_IDEMPOTENCY_RECEIPTS);
  }

  async #write(): Promise<void> {
    const state = this.#state!;
    while (state.idempotency.length > 0 && jsonBytes(state) + 1 > this.limits.maxBytes) {
      state.idempotency.shift();
    }
    while (state.audit.length > 0 && jsonBytes(state) + 1 > this.limits.maxBytes) {
      state.audit.shift();
      state.droppedAuditEvents += 1;
    }
    if (jsonBytes(state) + 1 > this.limits.maxBytes) {
      throw new DashboardAuthorizationError(
        "authorization_state_capacity",
        "authorization state exceeds its byte limit",
        503,
      );
    }
    await atomicWritePrivateJson(this.path, state);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      await this.initialize();
      this.#assertAvailable();
      const previous = structuredClone(this.#state!);
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof DashboardAuthorizationError &&
          error.code === "authorization_state_indeterminate"
        ) {
          this.#terminalFailure = error;
        } else {
          this.#state = previous;
          this.#reindexPolicies();
        }
        throw error;
      }
    });
  }

  #assertAvailable(): void {
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #timestamp(): string {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) throw new Error("now returned an invalid date");
    return value.toISOString();
  }
}

function appendAudit(
  state: DashboardAuthorizationState,
  limits: Readonly<DashboardAuthorizationLimits>,
  event: Omit<DashboardAuthorizationAuditEvent, "sequence" | "eventId" | "occurredAt">,
  occurredAt: string,
): void {
  state.audit.push({
    ...event,
    sequence: state.nextAuditSequence,
    eventId: `authorization-event-${randomUUID()}`,
    occurredAt,
  });
  state.nextAuditSequence += 1;
  while (state.audit.length > limits.maxAuditEvents) {
    state.audit.shift();
    state.droppedAuditEvents += 1;
  }
}

async function readAuthorizationState(
  path: string,
  limits: Readonly<DashboardAuthorizationLimits>,
): Promise<DashboardAuthorizationState> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyAuthorizationState();
    throw new DashboardAuthorizationError(
      "authorization_state_unavailable",
      "dashboard authorization state is unavailable",
      500,
    );
  }
  try {
    const info = await handle.stat();
    const getuid = process.getuid;
    if (
      !info.isFile() ||
      (getuid !== undefined && info.uid !== getuid()) ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > limits.maxBytes
    ) {
      throw corruptAuthorizationState();
    }
    const buffer = Buffer.allocUnsafe(limits.maxBytes + MAX_READ_SLACK_BYTES);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limits.maxBytes) throw corruptAuthorizationState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
    } catch {
      throw corruptAuthorizationState();
    }
    return validateStoredState(parsed, limits);
  } finally {
    await handle.close();
  }
}

function validateStoredState(
  value: unknown,
  limits: Readonly<DashboardAuthorizationLimits>,
): DashboardAuthorizationState {
  const object = storedObject(value);
  assertExactKeys(object, [
    "formatVersion",
    "revision",
    "nextAuditSequence",
    "droppedAuditEvents",
    "policies",
    "audit",
    "idempotency",
  ], ["idempotency"]);
  if (object.formatVersion !== AUTHORIZATION_FORMAT_VERSION) throw corruptAuthorizationState();
  const revision = storedInteger(object.revision);
  const nextAuditSequence = storedInteger(object.nextAuditSequence, 1);
  const droppedAuditEvents = storedInteger(object.droppedAuditEvents);
  if (!Array.isArray(object.policies) || object.policies.length > limits.maxPolicies) {
    throw corruptAuthorizationState();
  }
  if (!Array.isArray(object.audit) || object.audit.length > limits.maxAuditEvents) {
    throw corruptAuthorizationState();
  }
  if (
    object.idempotency !== undefined &&
    (!Array.isArray(object.idempotency) || object.idempotency.length > MAX_IDEMPOTENCY_RECEIPTS)
  ) {
    throw corruptAuthorizationState();
  }
  const policyKeys = new Set<string>();
  const policies = object.policies.map((entry) => {
    const policy = validateStoredPolicy(entry, limits);
    const key = resourceKey(policy.resource);
    if (policyKeys.has(key)) throw corruptAuthorizationState();
    policyKeys.add(key);
    return policy;
  });
  const audit = object.audit.map(validateStoredAuditEvent);
  const idempotency = (object.idempotency ?? []).map((entry) =>
    validateStoredIdempotencyReceipt(entry, limits),
  );
  const receiptKeys = new Set<string>();
  for (const receipt of idempotency) {
    const key = `${receipt.actorIdentityId}\u0000${receipt.key}`;
    if (receiptKeys.has(key)) throw corruptAuthorizationState();
    receiptKeys.add(key);
  }
  for (let index = 1; index < audit.length; index += 1) {
    if (audit[index - 1]!.sequence >= audit[index]!.sequence) throw corruptAuthorizationState();
  }
  if (audit.at(-1) !== undefined && audit.at(-1)!.sequence >= nextAuditSequence) {
    throw corruptAuthorizationState();
  }
  return {
    formatVersion: AUTHORIZATION_FORMAT_VERSION,
    revision,
    nextAuditSequence,
    droppedAuditEvents,
    policies,
    audit,
    idempotency,
  };
}

function validateStoredPolicy(
  value: unknown,
  limits: Readonly<DashboardAuthorizationLimits>,
): DashboardResourcePolicy {
  const object = storedObject(value);
  assertExactKeys(object, [
    "resource",
    "ownerIdentityId",
    "grants",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  const resource = validateStoredResourceRef(object.resource);
  const ownerIdentityId = validateStoredIdentityId(object.ownerIdentityId);
  if (!Array.isArray(object.grants) || object.grants.length > limits.maxGrantsPerPolicy) {
    throw corruptAuthorizationState();
  }
  const identities = new Set<string>();
  const grants = object.grants.map((entry) => {
    const grant = storedObject(entry);
    assertExactKeys(grant, ["identityId", "role"]);
    const identityId = validateStoredIdentityId(grant.identityId);
    if (identityId === ownerIdentityId || identities.has(identityId)) throw corruptAuthorizationState();
    identities.add(identityId);
    return { identityId, role: validateStoredRole(grant.role) };
  });
  return {
    resource,
    ownerIdentityId,
    grants,
    revision: storedInteger(object.revision, 1),
    createdAt: storedTimestamp(object.createdAt),
    updatedAt: storedTimestamp(object.updatedAt),
  };
}

function validateStoredAuditEvent(value: unknown): DashboardAuthorizationAuditEvent {
  const object = storedObject(value);
  const allowed = [
    "sequence",
    "eventId",
    "occurredAt",
    "actorIdentityId",
    "action",
    "resource",
    "subjectIdentityId",
    "role",
    "previousOwnerIdentityId",
    "previousControllerIdentityId",
  ];
  assertExactKeys(object, allowed, [
    "subjectIdentityId",
    "role",
    "previousOwnerIdentityId",
    "previousControllerIdentityId",
  ]);
  if (![
    "resource-created",
    "resource-adopted",
    "grant-set",
    "grant-revoked",
    "ownership-transferred",
    "controller-transferred",
  ].includes(object.action as string)) {
    throw corruptAuthorizationState();
  }
  const action = object.action as DashboardAuthorizationAuditAction;
  const subjectIdentityId = object.subjectIdentityId === undefined
    ? undefined
    : validateStoredIdentityId(object.subjectIdentityId);
  const role = object.role === undefined ? undefined : validateStoredRole(object.role);
  const previousOwnerIdentityId = object.previousOwnerIdentityId === undefined
    ? undefined
    : validateStoredIdentityId(object.previousOwnerIdentityId);
  const previousControllerIdentityId = object.previousControllerIdentityId === undefined
    ? undefined
    : validateStoredIdentityId(object.previousControllerIdentityId);
  if (
    ((action === "resource-created" || action === "resource-adopted") &&
      (subjectIdentityId === undefined || role !== undefined || previousOwnerIdentityId !== undefined || previousControllerIdentityId !== undefined)) ||
    (action === "grant-set" &&
      (subjectIdentityId === undefined || role === undefined || previousOwnerIdentityId !== undefined || previousControllerIdentityId !== undefined)) ||
    (action === "grant-revoked" &&
      (subjectIdentityId === undefined || role !== undefined || previousOwnerIdentityId !== undefined || previousControllerIdentityId !== undefined)) ||
    (action === "ownership-transferred" &&
      (subjectIdentityId === undefined || previousOwnerIdentityId === undefined || previousControllerIdentityId !== undefined)) ||
    (action === "controller-transferred" &&
      (subjectIdentityId === undefined || role !== undefined || previousOwnerIdentityId !== undefined))
  ) {
    throw corruptAuthorizationState();
  }
  return {
    sequence: storedInteger(object.sequence, 1),
    eventId: storedOpaqueString(object.eventId, 128),
    occurredAt: storedTimestamp(object.occurredAt),
    actorIdentityId: validateStoredIdentityId(object.actorIdentityId),
    action,
    resource: validateStoredResourceRef(object.resource),
    ...(subjectIdentityId === undefined ? {} : { subjectIdentityId }),
    ...(role === undefined ? {} : { role }),
    ...(previousOwnerIdentityId === undefined ? {} : { previousOwnerIdentityId }),
    ...(previousControllerIdentityId === undefined ? {} : { previousControllerIdentityId }),
  };
}

function validateStoredIdempotencyReceipt(
  value: unknown,
  limits: Readonly<DashboardAuthorizationLimits>,
): DashboardAuthorizationIdempotencyReceipt {
  const object = storedObject(value);
  assertExactKeys(object, ["actorIdentityId", "key", "fingerprint", "result"]);
  return {
    actorIdentityId: validateStoredIdentityId(object.actorIdentityId),
    key: storedOpaqueString(object.key, 512),
    fingerprint: storedOpaqueString(object.fingerprint, 128),
    result: validateStoredPolicy(object.result, limits),
  };
}

function validateResourceRef(value: unknown): DashboardResourceRef {
  if (!isRecord(value)) throw new DashboardAuthorizationError("invalid_request", "resource reference is invalid");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("id")) {
    throw new DashboardAuthorizationError("invalid_request", "resource reference is invalid");
  }
  const kinds: DashboardResourceKind[] = [
    "session",
    "workspace",
    "draft",
    "draft-ticket",
    "activation-ticket",
    "export-ticket",
    "schedule",
  ];
  if (!kinds.includes(value.kind as DashboardResourceKind)) {
    throw new DashboardAuthorizationError("invalid_request", "resource reference is invalid");
  }
  if (
    typeof value.id !== "string" ||
    Buffer.byteLength(value.id, "utf8") > MAX_RESOURCE_ID_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.id)
  ) {
    throw new DashboardAuthorizationError("invalid_request", "resource reference is invalid");
  }
  return { kind: value.kind as DashboardResourceKind, id: value.id };
}

function validateStoredResourceRef(value: unknown): DashboardResourceRef {
  try {
    return validateResourceRef(value);
  } catch {
    throw corruptAuthorizationState();
  }
}

function validatePrincipal(principal: DashboardPrincipal): void {
  validateDashboardIdentityId(principal.identityId);
  if (principal.globalRole !== "administrator" && principal.globalRole !== "member") {
    throw new Error("dashboard principal global role is invalid");
  }
}

function validateRole(role: unknown): asserts role is DashboardResourceRole {
  if (role !== "read" && role !== "control" && role !== "admin") {
    throw new DashboardAuthorizationError("invalid_request", "resource role is invalid");
  }
}

function validateStoredRole(role: unknown): DashboardResourceRole {
  try {
    validateRole(role);
    return role;
  } catch {
    throw corruptAuthorizationState();
  }
}

function validateStoredIdentityId(value: unknown): string {
  try {
    return validateDashboardIdentityId(value);
  } catch {
    throw corruptAuthorizationState();
  }
}

function validateRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DashboardAuthorizationError("invalid_request", "expected revision is invalid");
  }
}

function assertExpectedRevision(policy: DashboardResourcePolicy, expected: number): void {
  if (policy.revision !== expected) {
    throw new DashboardAuthorizationError(
      "authorization_revision_conflict",
      "authorization policy revision no longer matches",
      409,
    );
  }
}

function roleRank(role: DashboardResourceRole): number {
  return role === "read" ? 1 : role === "control" ? 2 : 3;
}

function resourceKey(resource: DashboardResourceRef): string {
  return `${resource.kind}:${resource.id}`;
}

function hiddenResourceError(): DashboardAuthorizationError {
  return new DashboardAuthorizationError("not_found", "dashboard resource was not found", 404);
}

function pendingReceipt(
  principal: DashboardPrincipal,
  key: string | undefined,
  request: Record<string, unknown>,
): PendingIdempotencyReceipt | undefined {
  if (key === undefined) return undefined;
  if (key.length < 1 || Buffer.byteLength(key, "utf8") > 512) {
    throw new DashboardAuthorizationError("invalid_request", "idempotency key is invalid");
  }
  return {
    actorIdentityId: principal.identityId,
    key,
    fingerprint: createHash("sha256").update(JSON.stringify(request), "utf8").digest("base64url"),
  };
}

function emptyAuthorizationState(): DashboardAuthorizationState {
  return {
    formatVersion: AUTHORIZATION_FORMAT_VERSION,
    revision: 0,
    nextAuditSequence: 1,
    droppedAuditEvents: 0,
    policies: [],
    audit: [],
    idempotency: [],
  };
}

function resolveAuthorizationLimits(
  overrides: Partial<DashboardAuthorizationLimits> | undefined,
): DashboardAuthorizationLimits {
  const limits = {
    maxPolicies: overrides?.maxPolicies ?? DEFAULT_DASHBOARD_AUTHORIZATION_MAX_POLICIES,
    maxGrantsPerPolicy:
      overrides?.maxGrantsPerPolicy ?? DEFAULT_DASHBOARD_AUTHORIZATION_MAX_GRANTS_PER_POLICY,
    maxAuditEvents:
      overrides?.maxAuditEvents ?? DEFAULT_DASHBOARD_AUTHORIZATION_MAX_AUDIT_EVENTS,
    maxBytes: overrides?.maxBytes ?? DEFAULT_DASHBOARD_AUTHORIZATION_MAX_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  }
  if (limits.maxPolicies > DEFAULT_DASHBOARD_AUTHORIZATION_MAX_POLICIES) {
    throw new Error("maxPolicies exceeds its hard limit");
  }
  if (limits.maxGrantsPerPolicy > DEFAULT_DASHBOARD_AUTHORIZATION_MAX_GRANTS_PER_POLICY) {
    throw new Error("maxGrantsPerPolicy exceeds its hard limit");
  }
  if (limits.maxAuditEvents > DEFAULT_DASHBOARD_AUTHORIZATION_MAX_AUDIT_EVENTS) {
    throw new Error("maxAuditEvents exceeds its hard limit");
  }
  if (limits.maxBytes > DEFAULT_DASHBOARD_AUTHORIZATION_MAX_BYTES) {
    throw new Error("maxBytes exceeds its hard limit");
  }
  return limits;
}

async function ensurePrivateDirectory(path: string, description: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const getuid = process.getuid;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (getuid !== undefined && info.uid !== getuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`${description} must be an owner-only real directory`);
  }
}

async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  let published = false;
  try {
    await rename(temporary, path);
    published = true;
    await chmod(path, 0o600);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!published) {
      await rm(temporary, { force: true });
      throw error;
    }
    throw new DashboardAuthorizationError(
      "authorization_state_indeterminate",
      "dashboard authorization publication became indeterminate",
      500,
    );
  }
}

function storedObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw corruptAuthorizationState();
  return value;
}

function assertExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    Object.keys(object).some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw corruptAuthorizationState();
  }
}

function storedInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw corruptAuthorizationState();
  return value as number;
}

function storedOpaqueString(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\r\n\0]/.test(value)
  ) {
    throw corruptAuthorizationState();
  }
  return value;
}

function storedTimestamp(value: unknown): string {
  const timestamp = storedOpaqueString(value, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw corruptAuthorizationState();
  return timestamp;
}

function corruptAuthorizationState(): DashboardAuthorizationError {
  return new DashboardAuthorizationError(
    "authorization_state_corrupt",
    "dashboard authorization state is invalid",
    500,
  );
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
