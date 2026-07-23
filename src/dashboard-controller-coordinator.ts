import { randomUUID } from "node:crypto";

import type {
  DashboardControllerParticipant,
  DashboardControllerState,
} from "./dashboard-authorization-contract.js";
import {
  DashboardAuthorizationError,
  type DashboardResourceRef,
  type DashboardResourceRole,
} from "./dashboard-authorization.js";
import type {
  DashboardCommandResult,
  DashboardControllerRole,
  DashboardPresentation,
} from "./dashboard-contract.js";

const MAX_CONTROLLER_RESOURCES = 1_024;
const MAX_PARTICIPANTS_PER_RESOURCE = 64;

interface ParticipantRecord {
  participantId: string;
  identityId: string;
  presentation: DashboardPresentation;
  role: () => DashboardControllerRole;
  requestControl: (correlationId: string) => Promise<DashboardCommandResult>;
  releaseControl: (correlationId: string) => Promise<DashboardCommandResult>;
  close: () => Promise<void>;
}

interface ControllerRecord {
  resource: DashboardResourceRef;
  revision: number;
  participants: Map<string, ParticipantRecord>;
  tail: Promise<void>;
}

export interface DashboardControllerRegistration {
  participantId: string;
  unregister(): void;
}

/**
 * Process-local coordinator for live browser controller leases. Resource
 * authorization remains in DashboardAuthorizationService; this registry only
 * sequences backend release/grant operations and exposes bounded, content-free
 * participant identity to resource administrators.
 */
export class DashboardControllerCoordinator {
  readonly #resources = new Map<string, ControllerRecord>();

  register(options: {
    resource: DashboardResourceRef;
    identityId: string;
    presentation: DashboardPresentation;
    role: () => DashboardControllerRole;
    requestControl: (correlationId: string) => Promise<DashboardCommandResult>;
    releaseControl: (correlationId: string) => Promise<DashboardCommandResult>;
    close: () => Promise<void>;
  }): DashboardControllerRegistration {
    const record = this.#record(options.resource, true);
    if (record.participants.size >= MAX_PARTICIPANTS_PER_RESOURCE) {
      throw new DashboardAuthorizationError(
        "controller_participant_capacity",
        "controller participant capacity is exhausted",
        503,
      );
    }
    const participantId = `controller-participant-${randomUUID()}`;
    record.participants.set(participantId, { participantId, ...options });
    return {
      participantId,
      unregister: () => {
        const current = this.#resources.get(resourceKey(options.resource));
        if (current === undefined) return;
        current.participants.delete(participantId);
        if (current.participants.size === 0) this.#resources.delete(resourceKey(options.resource));
      },
    };
  }

  state(resource: DashboardResourceRef): DashboardControllerState {
    const record = this.#record(resource, false);
    if (record === undefined) return { resource: structuredClone(resource), revision: 0, participants: [] };
    const participants = [...record.participants.values()]
      .map((participant): DashboardControllerParticipant => ({
        participantId: participant.participantId,
        identityId: participant.identityId,
        presentation: participant.presentation,
        role: participant.role(),
      }))
      .sort((left, right) =>
        left.identityId.localeCompare(right.identityId) ||
        left.participantId.localeCompare(right.participantId)
      );
    return {
      resource: structuredClone(record.resource),
      revision: record.revision,
      ...(() => {
        const controller = participants.find(({ role }) => role === "controller");
        return controller === undefined ? {} : { controllerIdentityId: controller.identityId };
      })(),
      participants,
    };
  }

  requestControl(
    resource: DashboardResourceRef,
    participantId: string,
    correlationId: string,
  ): Promise<DashboardCommandResult> {
    return this.#serialize(resource, async (record) => {
      const participant = requiredParticipant(record, participantId);
      const result = await participant.requestControl(correlationId);
      if (result.state === "completed") record.revision += 1;
      return result;
    });
  }

  releaseControl(
    resource: DashboardResourceRef,
    participantId: string,
    correlationId: string,
  ): Promise<DashboardCommandResult> {
    return this.#serialize(resource, async (record) => {
      const participant = requiredParticipant(record, participantId);
      const result = await participant.releaseControl(correlationId);
      if (result.state === "completed") record.revision += 1;
      return result;
    });
  }

  transfer(options: {
    resource: DashboardResourceRef;
    targetIdentityId: string;
    targetParticipantId?: string;
    expectedRevision: number;
    correlationId: string;
  }): Promise<{
    previousControllerIdentityId?: string;
    state: DashboardControllerState;
  }> {
    return this.#serialize(options.resource, async (record) => {
      if (record.revision !== options.expectedRevision) {
        throw new DashboardAuthorizationError(
          "controller_revision_conflict",
          "controller revision no longer matches",
          409,
        );
      }
      const participants = [...record.participants.values()];
      const current = participants.find((candidate) => candidate.role() === "controller");
      const target = options.targetParticipantId === undefined
        ? participants
            .filter((candidate) => candidate.identityId === options.targetIdentityId)
            .sort((left, right) => left.participantId.localeCompare(right.participantId))[0]
        : record.participants.get(options.targetParticipantId);
      if (target === undefined || target.identityId !== options.targetIdentityId) {
        throw new DashboardAuthorizationError(
          "controller_target_unavailable",
          "controller transfer target is unavailable",
          409,
        );
      }
      const previousControllerIdentityId = current?.identityId;
      if (current?.participantId === target.participantId) {
        return {
          ...(previousControllerIdentityId === undefined
            ? {}
            : { previousControllerIdentityId }),
          state: this.state(options.resource),
        };
      }
      if (current !== undefined) {
        ensureCompleted(
          await current.releaseControl(`${options.correlationId}:release`),
          "controller release failed",
        );
        record.revision += 1;
      }
      try {
        ensureCompleted(
          await target.requestControl(`${options.correlationId}:grant`),
          "controller grant failed",
        );
        record.revision += 1;
      } catch (error) {
        // Never restore the old controller automatically: the durable caller
        // must observe that release completed before deciding how to recover.
        throw error;
      }
      return {
        ...(previousControllerIdentityId === undefined
          ? {}
          : { previousControllerIdentityId }),
        state: this.state(options.resource),
      };
    });
  }

  async applyIdentityRole(
    resource: DashboardResourceRef,
    identityId: string,
    role: DashboardResourceRole | undefined,
  ): Promise<void> {
    const record = this.#record(resource, false);
    if (record === undefined) return;
    await this.#serialize(resource, async (current) => {
      const participants = [...current.participants.values()].filter(
        (participant) => participant.identityId === identityId,
      );
      if (role === undefined) {
        await Promise.allSettled(participants.map((participant) => participant.close()));
        return;
      }
      if (role === "read") {
        for (const participant of participants) {
          if (participant.role() !== "controller") continue;
          try {
            const result = await participant.releaseControl(`controller-revocation-${randomUUID()}`);
            if (result.state === "completed") {
              current.revision += 1;
              continue;
            }
          } catch {
            // Closing the channel is the fail-closed controller release path.
          }
          await participant.close();
        }
      }
    });
  }

  #record(resource: DashboardResourceRef, create: true): ControllerRecord;
  #record(resource: DashboardResourceRef, create: false): ControllerRecord | undefined;
  #record(resource: DashboardResourceRef, create: boolean): ControllerRecord | undefined {
    const key = resourceKey(resource);
    const existing = this.#resources.get(key);
    if (existing !== undefined || !create) return existing;
    if (this.#resources.size >= MAX_CONTROLLER_RESOURCES) {
      throw new DashboardAuthorizationError(
        "controller_resource_capacity",
        "controller resource capacity is exhausted",
        503,
      );
    }
    const record: ControllerRecord = {
      resource: structuredClone(resource),
      revision: 0,
      participants: new Map(),
      tail: Promise.resolve(),
    };
    this.#resources.set(key, record);
    return record;
  }

  #serialize<T>(
    resource: DashboardResourceRef,
    operation: (record: ControllerRecord) => Promise<T>,
  ): Promise<T> {
    const record = this.#record(resource, true);
    const result = record.tail.then(() => operation(record), () => operation(record));
    record.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function requiredParticipant(record: ControllerRecord, participantId: string): ParticipantRecord {
  const participant = record.participants.get(participantId);
  if (participant === undefined) {
    throw new DashboardAuthorizationError(
      "controller_target_unavailable",
      "controller participant is unavailable",
      409,
    );
  }
  return participant;
}

function ensureCompleted(result: DashboardCommandResult, message: string): void {
  if (result.state !== "completed") {
    throw new DashboardAuthorizationError("controller_transfer_failed", message, 409);
  }
}

function resourceKey(resource: DashboardResourceRef): string {
  return `${resource.kind}\u0000${resource.id}`;
}
