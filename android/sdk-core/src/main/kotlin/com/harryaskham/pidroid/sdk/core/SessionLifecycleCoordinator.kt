package com.harryaskham.pidroid.sdk.core

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType

@JvmInline
public value class ConnectionAttemptId(
  public val value: String,
) {
  init {
    require(value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) {
      "connection attempt ID must be a bounded unique identifier"
    }
  }
}

public enum class IncomingFrameDisposition {
  APPLIED,
  STALE_ATTEMPT_IGNORED,
  RESYNC_REQUIRED,
}

/** Caller-executed attachment instruction. Constructing it performs no I/O. */
public class SessionAttachDirective internal constructor(
  public val attemptId: ConnectionAttemptId,
  public val session: SessionKey,
  public val role: SessionRole,
  public val cursor: String?,
) {
  override fun toString(): String = "SessionAttachDirective(attemptId=${attemptId.value}, session=$session, role=$role, cursor=[REDACTED])"
}

public class ResumableCommand internal constructor(
  public val correlationId: CorrelationId,
  public val kind: PiRpcCommandType,
  lifecycle: CommandLifecycle,
) {
  public var lifecycle: CommandLifecycle = lifecycle
    internal set

  override fun toString(): String =
    "ResumableCommand(correlationId=${correlationId.value}, kind=${kind.wireValue}, lifecycle=$lifecycle, content=[REDACTED])"
}

public class ResumableTicket internal constructor(
  public val ticketId: String,
  public val request: DurableRequestIdentity,
  public val state: TicketState,
  public val session: SessionKey?,
) {
  override fun toString(): String = "ResumableTicket(ticketId=$ticketId, requestId=${request.requestId}, state=$state, session=$session)"
}

/**
 * Content-free process-persistence value. It intentionally contains no bearer, cwd, prompt,
 * transcript, command body, result, or error detail. [SessionResumeSnapshotCodec] owns strict
 * encoding, the embedding application owns atomic storage, and [SessionLifecycleCoordinator.restore]
 * owns recovery semantics.
 */
public class SessionResumeSnapshot internal constructor(
  public val formatVersion: Int,
  public val hostId: HostId,
  public val hostInstanceId: String?,
  public val session: SessionKey,
  public val replayCursor: String?,
  public val usedConnectionAttempts: Set<ConnectionAttemptId>,
  public val issuedRequests: Set<DurableRequestIdentity>,
  public val commands: List<ResumableCommand>,
  public val tickets: List<ResumableTicket>,
) {
  override fun toString(): String =
    "SessionResumeSnapshot(formatVersion=$formatVersion, hostId=${hostId.value}, hostInstanceId=${hostInstanceId != null}, session=$session, cursor=[REDACTED], attempts=${usedConnectionAttempts.size}, requests=${issuedRequests.size}, commands=${commands.size}, tickets=${tickets.size}, content=[REDACTED])"
}

public class SessionLifecycleState internal constructor(
  public val hostId: HostId,
  public val hostInstanceId: String?,
  public val session: SessionKey,
  public val activeAttempt: ConnectionAttemptId?,
  public val connection: InteractiveConnectionState,
  public val role: InteractiveControllerRole,
  public val replayCursor: String?,
  public val processResumed: Boolean,
) {
  override fun toString(): String =
    "SessionLifecycleState(hostId=${hostId.value}, hostInstanceId=${hostInstanceId != null}, session=$session, activeAttempt=${activeAttempt?.value}, connection=$connection, role=$role, cursor=[REDACTED], processResumed=$processResumed)"
}

/**
 * Pure lifecycle coordinator for one exact host/session generation.
 *
 * Callers provide every connection/correlation/request identity, execute returned wire actions
 * exactly once, and persist [snapshot] after transitions. Stale connection frames are ignored. A
 * replay gap or attachment identity mismatch clears cursor/authority and returns
 * [IncomingFrameDisposition.RESYNC_REQUIRED]. A
 * disconnect or process restore marks unanswered commands indeterminate; this class never reconnects,
 * retries, replays, or starts/stops a daemon.
 */
public class SessionLifecycleCoordinator private constructor(
  private val hostId: HostId,
  private val hostInstanceId: String?,
  private val session: SessionKey,
  supportedCommands: Set<PiRpcCommandType>,
  private val maxRememberedIdentities: Int,
  private val processResumed: Boolean,
  resume: SessionResumeSnapshot?,
  maxInFlight: Int,
) {
  private val controller =
    InteractiveSessionController(
      session = session,
      supportedCommands = supportedCommands,
      expectedHostInstanceId = hostInstanceId,
      maxInFlight = maxInFlight,
    )
  private val usedAttempts = linkedSetOf<ConnectionAttemptId>()
  private val issuedRequests = linkedSetOf<DurableRequestIdentity>()
  private val commands = linkedMapOf<CorrelationId, ResumableCommand>()
  private val tickets = linkedMapOf<String, ResumableTicket>()
  private var activeAttempt: ConnectionAttemptId? = null
  private var replayCursor: String? = null

  init {
    require(maxRememberedIdentities in 8..2_048) { "remembered identity bound is invalid" }
    require(
      hostInstanceId == null || hostInstanceId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")),
    ) { "host instance ID is invalid" }
    resume?.let { restored ->
      usedAttempts.addAll(restored.usedConnectionAttempts)
      issuedRequests.addAll(restored.issuedRequests)
      restored.commands.forEach { command ->
        val restoredLifecycle =
          if (command.lifecycle == CommandLifecycle.IN_FLIGHT) CommandLifecycle.INDETERMINATE else command.lifecycle
        commands[command.correlationId] = ResumableCommand(command.correlationId, command.kind, restoredLifecycle)
      }
      restored.tickets.forEach { ticket -> tickets[ticket.ticketId] = ticket }
      replayCursor = restored.replayCursor
    }
    require(usedAttempts.size <= maxRememberedIdentities) { "restored connection identities exceed the bound" }
    require(issuedRequests.size <= maxRememberedIdentities) { "restored request identities exceed the bound" }
    require(commands.size <= maxRememberedIdentities) { "restored command identities exceed the bound" }
    require(tickets.size <= maxRememberedIdentities) { "restored ticket identities exceed the bound" }
  }

  public val state: SessionLifecycleState
    @Synchronized get() {
      val interactive = controller.state
      return SessionLifecycleState(
        hostId = hostId,
        hostInstanceId = hostInstanceId,
        session = session,
        activeAttempt = activeAttempt,
        connection = interactive.connection,
        role = interactive.role,
        replayCursor = replayCursor,
        processResumed = processResumed,
      )
    }

  /** Begin one caller-owned socket attempt. The returned cursor is advisory replay state only. */
  @Synchronized
  public fun beginConnection(attemptId: ConnectionAttemptId): SessionAttachDirective {
    if (attemptId in usedAttempts) {
      throw CommandAdmissionException("duplicate_connection_attempt", "connection attempt identity was already used")
    }
    ensureCapacity(usedAttempts.size, "connection_attempt_capacity")
    activeAttempt?.let {
      controller.onDisconnect()
      synchronizeInflightAsIndeterminate()
    }
    usedAttempts += attemptId
    activeAttempt = attemptId
    return SessionAttachDirective(attemptId, session, SessionRole.OBSERVER, replayCursor)
  }

  @Synchronized
  public fun onFrame(
    attemptId: ConnectionAttemptId,
    frame: SessionRpcFrame,
  ): IncomingFrameDisposition {
    if (attemptId != activeAttempt) return IncomingFrameDisposition.STALE_ATTEMPT_IGNORED
    try {
      controller.onFrame(frame)
    } catch (error: ProtocolDecodeException) {
      if (error.code != "session_identity_mismatch") throw error
      replayCursor = null
      synchronizeInflightAsIndeterminate()
      return IncomingFrameDisposition.RESYNC_REQUIRED
    }
    when (frame) {
      is SessionRpcFrame.AttachReady -> {
        replayCursor = frame.highWaterCursor
      }

      is SessionRpcFrame.Event -> {
        replayCursor = frame.cursor
      }

      is SessionRpcFrame.Response -> {
        synchronizeCommand(frame.correlationId)
      }

      is SessionRpcFrame.ReplayGap -> {
        replayCursor = null
        synchronizeInflightAsIndeterminate()
        return IncomingFrameDisposition.RESYNC_REQUIRED
      }

      else -> {
        return IncomingFrameDisposition.APPLIED
      }
    }
    return IncomingFrameDisposition.APPLIED
  }

  /** Returns false for a stale socket callback and leaves current state untouched. */
  @Synchronized
  public fun onDisconnect(attemptId: ConnectionAttemptId): Boolean {
    if (attemptId != activeAttempt) return false
    controller.onDisconnect()
    synchronizeInflightAsIndeterminate()
    activeAttempt = null
    return true
  }

  @Synchronized
  public fun requestControl(attemptId: ConnectionAttemptId): OutboundControl {
    requireActiveAttempt(attemptId)
    return controller.requestControl()
  }

  @Synchronized
  public fun releaseControl(attemptId: ConnectionAttemptId): OutboundControl {
    requireActiveAttempt(attemptId)
    return controller.releaseControl()
  }

  /**
   * Admit one unique prompt/wake or control command. The returned text is a one-shot caller send;
   * neither it nor its content is retained in [snapshot].
   */
  @Synchronized
  public fun submit(
    attemptId: ConnectionAttemptId,
    intent: SessionCommandIntent,
    correlationId: CorrelationId,
  ): OutboundCommand {
    requireActiveAttempt(attemptId)
    if (correlationId in commands) {
      throw CommandAdmissionException("duplicate_correlation", "command correlation identity was already used")
    }
    ensureCapacity(commands.size, "command_identity_capacity")
    val outbound = controller.submit(intent, correlationId)
    commands[correlationId] = ResumableCommand(correlationId, intent.kind, CommandLifecycle.IN_FLIGHT)
    return outbound
  }

  /** Record a REST mutation identity before or immediately after its one-shot caller send. */
  @Synchronized
  public fun rememberRequest(identity: DurableRequestIdentity) {
    if (identity in issuedRequests) return
    if (issuedRequests.any { it.requestId == identity.requestId || it.idempotencyKey == identity.idempotencyKey }) {
      throw CommandAdmissionException("request_identity_conflict", "request or idempotency identity was reused inconsistently")
    }
    ensureCapacity(issuedRequests.size, "request_identity_capacity")
    issuedRequests += identity
  }

  @Synchronized
  public fun rememberTicket(ticket: DurableTicket) {
    val request = DurableRequestIdentity(ticket.requestId, ticket.idempotencyKey)
    rememberRequest(request)
    val sessionIdentity =
      ticket.sessionId?.let { sessionId -> ticket.generation?.let { generation -> SessionKey(sessionId, generation) } }
    rememberTicket(ResumableTicket(ticket.ticketId, request, ticket.state, sessionIdentity))
  }

  @Synchronized
  public fun rememberTicket(ticket: DashboardActivationTicket) {
    val request = DurableRequestIdentity(ticket.requestId, ticket.idempotencyKey)
    rememberRequest(request)
    rememberTicket(ResumableTicket(ticket.ticketId, request, ticket.state, ticket.managedSession))
  }

  @Synchronized
  public fun command(correlationId: String): ResumableCommand? =
    runCatching { CorrelationId(correlationId) }.getOrNull()?.let(commands::get)

  public fun canReplay(correlationId: String): Boolean = false

  @Synchronized
  public fun snapshot(): SessionResumeSnapshot =
    SessionResumeSnapshot(
      formatVersion = 1,
      hostId = hostId,
      hostInstanceId = hostInstanceId,
      session = session,
      replayCursor = replayCursor,
      usedConnectionAttempts = usedAttempts.toSet(),
      issuedRequests = issuedRequests.toSet(),
      commands = commands.values.map { ResumableCommand(it.correlationId, it.kind, it.lifecycle) },
      tickets = tickets.values.map { ResumableTicket(it.ticketId, it.request, it.state, it.session) },
    )

  override fun toString(): String =
    "SessionLifecycleCoordinator(state=$state, attempts=${usedAttempts.size}, requests=${issuedRequests.size}, commands=${commands.size}, tickets=${tickets.size}, content=[REDACTED])"

  private fun requireActiveAttempt(attemptId: ConnectionAttemptId) {
    if (attemptId != activeAttempt) {
      throw CommandAdmissionException("stale_connection_attempt", "operation belongs to a stale connection attempt")
    }
  }

  private fun synchronizeCommand(correlationId: String) {
    val correlation = runCatching { CorrelationId(correlationId) }.getOrNull() ?: return
    val lifecycle = controller.command(correlationId)?.lifecycle ?: return
    commands[correlation]?.lifecycle = lifecycle
  }

  private fun synchronizeInflightAsIndeterminate() {
    commands.values
      .filter { it.lifecycle == CommandLifecycle.IN_FLIGHT }
      .forEach { it.lifecycle = CommandLifecycle.INDETERMINATE }
  }

  private fun rememberTicket(ticket: ResumableTicket) {
    val existing = tickets[ticket.ticketId]
    if (existing == null) {
      ensureCapacity(tickets.size, "ticket_identity_capacity")
    } else if (existing.request != ticket.request) {
      throw CommandAdmissionException("ticket_identity_conflict", "ticket identity changed across reconciliation")
    }
    tickets[ticket.ticketId] = ticket
  }

  private fun ensureCapacity(
    currentSize: Int,
    code: String,
  ) {
    if (currentSize >= maxRememberedIdentities) {
      throw CommandAdmissionException(code, "remembered lifecycle identity bound is reached")
    }
  }

  public companion object {
    public fun create(
      hostId: HostId,
      session: SessionKey,
      supportedCommands: Set<PiRpcCommandType>,
      hostInstanceId: String? = null,
      maxInFlight: Int = 8,
      maxRememberedIdentities: Int = 256,
    ): SessionLifecycleCoordinator =
      SessionLifecycleCoordinator(
        hostId = hostId,
        hostInstanceId = hostInstanceId,
        session = session,
        supportedCommands = supportedCommands,
        maxRememberedIdentities = maxRememberedIdentities,
        processResumed = false,
        resume = null,
        maxInFlight = maxInFlight,
      )

    /** Restore content-free state. Any command that was in-flight becomes indeterminate. */
    public fun restore(
      snapshot: SessionResumeSnapshot,
      supportedCommands: Set<PiRpcCommandType>,
      maxInFlight: Int = 8,
      maxRememberedIdentities: Int = 256,
    ): SessionLifecycleCoordinator {
      require(snapshot.formatVersion == 1) { "resume snapshot format is unsupported" }
      return SessionLifecycleCoordinator(
        hostId = snapshot.hostId,
        hostInstanceId = snapshot.hostInstanceId,
        session = snapshot.session,
        supportedCommands = supportedCommands,
        maxRememberedIdentities = maxRememberedIdentities,
        processResumed = true,
        resume = snapshot,
        maxInFlight = maxInFlight,
      )
    }
  }
}
