import { randomUUID } from "node:crypto";

import { Multiplexer, MultiplexerError } from "./multiplexer.js";
import type { ProtocolCommand } from "./protocol.js";
import type { SessionCatalogRecord } from "./session-catalog.js";
import {
  parseSessionConfiguration,
  requireProvisionedEnvironment,
  sessionOpenPayloadFromSpec,
} from "./session-config.js";

/**
 * Reopen one retained session through its persisted policy without submitting a
 * prompt. Dashboard and attachment transports share this boundary so hydration
 * never drifts into a second runtime or bypasses catalog generation checks.
 */
export async function ensureSessionResident(
  multiplexer: Multiplexer,
  sessionRef: string,
  requestedGeneration?: number,
): Promise<SessionCatalogRecord> {
  const retained = await multiplexer.retainedSession(sessionRef);
  if (retained === undefined) {
    throw new MultiplexerError("session_not_found", "retained session does not exist");
  }
  if (
    requestedGeneration !== undefined &&
    retained.generation !== requestedGeneration
  ) {
    throw new MultiplexerError("stale_generation", "session generation changed");
  }
  if (retained.residency === "resident") return retained;

  const prepared = parseSessionConfiguration(retained.spec);
  requireProvisionedEnvironment(
    retained.environment,
    prepared.runtimeOptions.environmentOverlay,
  );
  let runtimeOptions = prepared.runtimeOptions;
  if (retained.spec.target.mode === "fork") {
    const sourceRef = retained.spec.target.sourceSession;
    const source =
      sourceRef === undefined
        ? undefined
        : await multiplexer.retainedSession(sourceRef);
    if (source?.conversation?.sessionFile === undefined) {
      throw new MultiplexerError(
        "fork_source_unavailable",
        "fork source has no retained Pi conversation",
      );
    }
    runtimeOptions = {
      ...runtimeOptions,
      resolvedSourceSessionPath: source.conversation.sessionFile,
    };
  }

  const command: Extract<ProtocolCommand, { operation: "open" }> = {
    protocolVersion: "1.0",
    requestId: `session-hydrate-${randomUUID()}`,
    operation: "open",
    sessionId: retained.sessionId,
    generation: retained.generation,
    payload: sessionOpenPayloadFromSpec(prepared.persistedSpec),
  };
  await multiplexer.open(command, {
    runtimeOptions,
    environmentSummary: retained.environment,
    catalogSpec: retained.spec,
  });
  const resident = await multiplexer.retainedSession(retained.sessionId);
  if (resident === undefined || resident.residency !== "resident") {
    throw new MultiplexerError(
      "hydration_failed",
      "session did not become resident",
      { retryable: true },
    );
  }
  return resident;
}
