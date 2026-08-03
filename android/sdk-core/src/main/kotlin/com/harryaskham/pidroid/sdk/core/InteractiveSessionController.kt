package com.harryaskham.pidroid.sdk.core

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

public enum class InteractiveConnectionState {
  DETACHED,
  READY,
  RESYNCING,
  DISCONNECTED,
}

public enum class InteractiveControllerRole {
  OBSERVER,
  REQUESTING,
  CONTROLLER,
  DENIED,
  LOST,
}

public enum class CommandLifecycle {
  IN_FLIGHT,
  SUCCEEDED,
  FAILED,
  INDETERMINATE,
}

public class InteractiveSessionState internal constructor(
  public val session: SessionKey,
  public val connection: InteractiveConnectionState,
  public val role: InteractiveControllerRole,
  public val connectionId: String?,
  public val highWaterCursor: String?,
) {
  override fun toString(): String =
    "InteractiveSessionState(session=${session.sessionId}, generation=${session.generation}, connection=$connection, role=$role, connectionId=${connectionId != null}, cursor=[REDACTED])"
}

public class TrackedCommand internal constructor(
  public val correlationId: CorrelationId,
  public val kind: PiRpcCommandType,
  lifecycle: CommandLifecycle,
) {
  public var lifecycle: CommandLifecycle = lifecycle
    internal set

  override fun toString(): String =
    "TrackedCommand(correlationId=${correlationId.value}, kind=${kind.wireValue}, lifecycle=$lifecycle, content=[REDACTED])"
}

public class OutboundCommand internal constructor(
  public val correlationId: CorrelationId,
  public val kind: PiRpcCommandType,
  public val text: String,
) {
  override fun toString(): String = "OutboundCommand(correlationId=${correlationId.value}, kind=${kind.wireValue}, text=[REDACTED])"
}

public class OutboundControl internal constructor(
  public val action: String,
  public val text: String,
) {
  override fun toString(): String = "OutboundControl(action=$action, text=[REDACTED])"
}

public class CommandAdmissionException(
  public val code: String,
  message: String,
) : IllegalStateException(message)

/**
 * Deterministic controller/replay state for one exact session generation. Controller authority is
 * established only by an `attach_ready` controller role or explicit `control_granted`; it is cleared
 * on replay gap or disconnect. Lost in-flight responses become [CommandLifecycle.INDETERMINATE] and
 * the same correlation identity can never be blindly submitted again.
 */
public class InteractiveSessionController(
  private val session: SessionKey,
  private val supportedCommands: Set<PiRpcCommandType>,
  private val expectedHostInstanceId: String? = null,
  private val maxInFlight: Int = 8,
) {
  private var connection = InteractiveConnectionState.DETACHED
  private var role = InteractiveControllerRole.OBSERVER
  private var connectionId: String? = null
  private var highWaterCursor: String? = null
  private val commands = linkedMapOf<CorrelationId, TrackedCommand>()

  init {
    require(maxInFlight in 1..64) { "in-flight command bound is invalid" }
    require(
      expectedHostInstanceId == null ||
        expectedHostInstanceId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")),
    ) { "expected host instance ID is invalid" }
  }

  public val state: InteractiveSessionState
    @Synchronized get() = InteractiveSessionState(session, connection, role, connectionId, highWaterCursor)

  @Synchronized
  public fun submit(
    intent: SessionCommandIntent,
    correlationId: CorrelationId,
  ): OutboundCommand {
    if (connection != InteractiveConnectionState.READY) {
      throw CommandAdmissionException("session_not_ready", "interactive session is not ready")
    }
    if (role != InteractiveControllerRole.CONTROLLER) {
      throw CommandAdmissionException("controller_required", "current connection does not hold controller authority")
    }
    if (intent.kind !in supportedCommands) {
      throw CommandAdmissionException("unsupported_command", "command is not advertised by this host")
    }
    if (correlationId in commands) {
      throw CommandAdmissionException("duplicate_correlation", "command correlation identity was already used")
    }
    if (commands.values.count { it.lifecycle == CommandLifecycle.IN_FLIGHT } >= maxInFlight) {
      throw CommandAdmissionException("too_many_in_flight", "in-flight command bound is reached")
    }
    commands[correlationId] = TrackedCommand(correlationId, intent.kind, CommandLifecycle.IN_FLIGHT)
    return OutboundCommand(correlationId, intent.kind, InteractiveCommandCodec.encode(intent, correlationId))
  }

  @Synchronized
  public fun requestControl(): OutboundControl {
    if (connection != InteractiveConnectionState.READY) {
      throw CommandAdmissionException("session_not_ready", "interactive session is not ready")
    }
    if (role == InteractiveControllerRole.CONTROLLER) {
      throw CommandAdmissionException("already_controller", "current connection already holds controller authority")
    }
    role = InteractiveControllerRole.REQUESTING
    return control("request_control")
  }

  @Synchronized
  public fun releaseControl(): OutboundControl {
    if (connection != InteractiveConnectionState.READY || role != InteractiveControllerRole.CONTROLLER) {
      throw CommandAdmissionException("controller_required", "current connection does not hold controller authority")
    }
    role = InteractiveControllerRole.OBSERVER
    return control("release_control")
  }

  @Synchronized
  public fun onFrame(frame: SessionRpcFrame) {
    when (frame) {
      is SessionRpcFrame.AttachReady -> onAttachReady(frame)
      is SessionRpcFrame.Control -> onControl(frame)
      is SessionRpcFrame.Response -> onResponse(frame)
      is SessionRpcFrame.ReplayGap -> enterResync()
      else -> Unit
    }
  }

  @Synchronized
  public fun onDisconnect() {
    markInflightIndeterminate()
    connection = InteractiveConnectionState.DISCONNECTED
    role = InteractiveControllerRole.LOST
    connectionId = null
    highWaterCursor = null
  }

  @Synchronized
  public fun command(correlationId: String): TrackedCommand? = commands[runCatching { CorrelationId(correlationId) }.getOrNull()]

  @Synchronized
  public fun canReplay(correlationId: String): Boolean = false

  private fun onAttachReady(frame: SessionRpcFrame.AttachReady) {
    if (
      frame.sessionId != session.sessionId ||
      frame.generation != session.generation ||
      (expectedHostInstanceId != null && frame.hostInstanceId != expectedHostInstanceId)
    ) {
      enterResync()
      throw ProtocolDecodeException("session_identity_mismatch", "attach snapshot belongs to another session generation")
    }
    connection = InteractiveConnectionState.READY
    role =
      when (frame.role) {
        SessionRole.CONTROLLER -> InteractiveControllerRole.CONTROLLER
        SessionRole.OBSERVER -> InteractiveControllerRole.OBSERVER
      }
    connectionId = frame.connectionId
    highWaterCursor = frame.highWaterCursor
  }

  private fun onControl(frame: SessionRpcFrame.Control) {
    if (connection != InteractiveConnectionState.READY) return
    when (frame.action) {
      "control_granted" -> {
        role = InteractiveControllerRole.CONTROLLER
        connectionId = frame.connectionId ?: connectionId
      }

      "control_denied" -> {
        role = InteractiveControllerRole.DENIED
      }
    }
  }

  private fun onResponse(frame: SessionRpcFrame.Response) {
    val correlation = runCatching { CorrelationId(frame.correlationId) }.getOrNull() ?: return
    val tracked = commands[correlation] ?: return
    if (tracked.lifecycle != CommandLifecycle.IN_FLIGHT) return
    val response = frame.raw["response"] as? JsonObject ?: return
    val success = (response["success"] as? JsonPrimitive)?.booleanOrNull ?: return
    tracked.lifecycle = if (success) CommandLifecycle.SUCCEEDED else CommandLifecycle.FAILED
  }

  private fun enterResync() {
    markInflightIndeterminate()
    connection = InteractiveConnectionState.RESYNCING
    role = InteractiveControllerRole.OBSERVER
    connectionId = null
    highWaterCursor = null
  }

  private fun markInflightIndeterminate() {
    commands.values
      .filter { it.lifecycle == CommandLifecycle.IN_FLIGHT }
      .forEach { it.lifecycle = CommandLifecycle.INDETERMINATE }
  }

  override fun toString(): String =
    "InteractiveSessionController(session=${session.sessionId}, generation=${session.generation}, supported=${supportedCommands.size}, state=${state.connection}/${state.role}, commands=${commands.size}, content=[REDACTED])"

  private fun control(action: String): OutboundControl =
    OutboundControl(
      action,
      JsonObject(
        linkedMapOf(
          "kind" to JsonPrimitive("control"),
          "action" to JsonPrimitive(action),
        ),
      ).toString(),
    )
}
