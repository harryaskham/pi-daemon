package com.harryaskham.pidroid.sdk.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

public enum class SessionRole(
  public val wireValue: String,
) {
  CONTROLLER("controller"),
  OBSERVER("observer"),
  ;

  public companion object {
    public fun fromWireValue(value: String): SessionRole? = entries.firstOrNull { it.wireValue == value }
  }
}

/**
 * Bounded neutral frame view for `pi-daemon-rpc.v1`.
 *
 * Raw JSON is retained for additive fields, while string renderings omit command/event content.
 * [AttachReady] establishes host/session/generation authority. [ReplayGap] is never hidden or
 * auto-healed: consumers must discard incompatible replay state and wait for the declared snapshot.
 */
public sealed interface SessionRpcFrame {
  public val kind: String
  public val raw: JsonObject

  public class AttachReady internal constructor(
    public val connectionId: String,
    public val role: SessionRole,
    public val hostInstanceId: String,
    public val sessionId: String,
    public val generation: Int,
    public val highWaterCursor: String,
    public val oldestAvailableCursor: String?,
    public val snapshot: JsonObject,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "attach_ready"

    override fun toString(): String = "SessionRpcFrame.AttachReady(role=$role, generation=$generation, identity=[REDACTED])"
  }

  public class ReplayGap internal constructor(
    public val reason: String,
    public val requestedCursor: String?,
    public val oldestAvailableCursor: String?,
    public val highWaterCursor: String,
    public val snapshotFollows: Boolean,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "replay_gap"

    override fun toString(): String = "SessionRpcFrame.ReplayGap(reason=$reason, snapshotFollows=$snapshotFollows, cursors=[REDACTED])"
  }

  public class Command internal constructor(
    public val correlationId: String,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "command"

    override fun toString(): String = "SessionRpcFrame.Command(correlationId=$correlationId, content=[REDACTED])"
  }

  public class Response internal constructor(
    public val correlationId: String,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "response"

    override fun toString(): String = "SessionRpcFrame.Response(correlationId=$correlationId, content=[REDACTED])"
  }

  public class Event internal constructor(
    public val cursor: String,
    public val sequence: Int,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "event"

    override fun toString(): String = "SessionRpcFrame.Event(sequence=$sequence, cursor=[REDACTED], content=[REDACTED])"
  }

  public class Control internal constructor(
    public val action: String,
    public val connectionId: String?,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "control"

    override fun toString(): String = "SessionRpcFrame.Control(action=$action, connectionId=$connectionId)"
  }

  public class ExtensionUiResponse internal constructor(
    public val correlationId: String,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "extension_ui_response"

    override fun toString(): String = "SessionRpcFrame.ExtensionUiResponse(correlationId=$correlationId, content=[REDACTED])"
  }

  public class TreeNavigate internal constructor(
    public val correlationId: String,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "tree_navigate"

    override fun toString(): String = "SessionRpcFrame.TreeNavigate(correlationId=$correlationId, content=[REDACTED])"
  }

  public class TreeNavigateResult internal constructor(
    public val correlationId: String,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override val kind: String = "tree_navigate_result"

    override fun toString(): String = "SessionRpcFrame.TreeNavigateResult(correlationId=$correlationId, content=[REDACTED])"
  }

  public class Unknown internal constructor(
    override val kind: String,
    override val raw: JsonObject,
  ) : SessionRpcFrame {
    override fun toString(): String = "SessionRpcFrame.Unknown(kind=$kind, content=[REDACTED])"
  }
}

/**
 * Decodes one bounded text frame without executing, replaying, or interpreting command content.
 * Correlation IDs are projected for request/response matching; unknown additive frame kinds remain
 * inert [SessionRpcFrame.Unknown] values.
 */
public object SessionRpcFrameCodec {
  public const val DEFAULT_MAX_FRAME_BYTES: Int = 1_048_576

  public fun decode(
    text: String,
    maxFrameBytes: Int = DEFAULT_MAX_FRAME_BYTES,
  ): SessionRpcFrame {
    require(maxFrameBytes in 1..16_777_216) { "frame bound is outside supported limits" }
    if (text.length > maxFrameBytes) {
      throw ProtocolDecodeException("message_too_large", "WebSocket frame exceeds the negotiated safety bound")
    }
    val raw =
      SessionApiCodec.decodeObject(
        text.encodeToByteArray(),
        maxFrameBytes,
        "WebSocket frame",
      )
    return when (val kind = raw.requiredWireName("kind")) {
      "attach_ready" -> {
        decodeAttachReady(raw)
      }

      "replay_gap" -> {
        decodeReplayGap(raw)
      }

      "command" -> {
        SessionRpcFrame.Command(raw.requiredNestedIdentifier("command", "id"), raw)
      }

      "response" -> {
        SessionRpcFrame.Response(raw.requiredNestedIdentifier("response", "id"), raw)
      }

      "event" -> {
        SessionRpcFrame.Event(
          cursor = raw.requiredString("cursor"),
          sequence = raw.requiredNonNegativeInt("sequence"),
          raw = raw,
        )
      }

      "control" -> {
        SessionRpcFrame.Control(
          action = raw.requiredWireName("action"),
          connectionId = raw.optionalIdentifier("connectionId"),
          raw = raw,
        )
      }

      "extension_ui_response" -> {
        SessionRpcFrame.ExtensionUiResponse(raw.requiredNestedIdentifier("response", "id"), raw)
      }

      "tree_navigate" -> {
        SessionRpcFrame.TreeNavigate(raw.requiredNestedIdentifier("request", "id"), raw)
      }

      "tree_navigate_result" -> {
        SessionRpcFrame.TreeNavigateResult(raw.requiredNestedIdentifier("result", "id"), raw)
      }

      else -> {
        SessionRpcFrame.Unknown(kind, raw)
      }
    }
  }

  private fun decodeAttachReady(raw: JsonObject): SessionRpcFrame.AttachReady {
    val roleValue = raw.requiredString("role")
    return SessionRpcFrame.AttachReady(
      connectionId = raw.requiredIdentifier("connectionId"),
      role =
        SessionRole.fromWireValue(roleValue)
          ?: throw ProtocolDecodeException("unsupported_role", "attach role is unsupported"),
      hostInstanceId = raw.requiredIdentifier("hostInstanceId"),
      sessionId = raw.requiredIdentifier("sessionId"),
      generation = raw.requiredNonNegativeInt("generation"),
      highWaterCursor = raw.requiredString("highWaterCursor"),
      oldestAvailableCursor = raw.optionalString("oldestAvailableCursor"),
      snapshot =
        raw["snapshot"] as? JsonObject
          ?: throw ProtocolDecodeException("invalid_snapshot", "attach snapshot is missing or invalid"),
      raw = raw,
    )
  }

  private fun decodeReplayGap(raw: JsonObject): SessionRpcFrame.ReplayGap =
    SessionRpcFrame.ReplayGap(
      reason = raw.requiredWireName("reason"),
      requestedCursor = raw.optionalString("requestedCursor"),
      oldestAvailableCursor = raw.optionalString("oldestAvailableCursor"),
      highWaterCursor = raw.requiredString("highWaterCursor"),
      snapshotFollows =
        (raw["snapshotFollows"] as? JsonPrimitive)?.booleanOrNull
          ?: throw ProtocolDecodeException(
            "invalid_field",
            "required boolean field is missing or invalid: snapshotFollows",
          ),
      raw = raw,
    )
}

private val WIRE_NAME = Regex("^[a-z][a-z0-9_]{0,127}$")
private val IDENTIFIER = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

private fun JsonObject.requiredWireName(name: String): String =
  requiredString(name).takeIf(WIRE_NAME::matches)
    ?: throw ProtocolDecodeException("invalid_field", "required wire-name field is invalid: $name")

private fun JsonObject.requiredIdentifier(name: String): String =
  requiredString(name).takeIf(IDENTIFIER::matches)
    ?: throw ProtocolDecodeException("invalid_field", "required identifier field is invalid: $name")

private fun JsonObject.optionalIdentifier(name: String): String? =
  optionalString(name)?.takeIf(IDENTIFIER::matches)
    ?: if (this[name] == null) {
      null
    } else {
      throw ProtocolDecodeException("invalid_field", "optional identifier field is invalid: $name")
    }

private fun JsonObject.requiredNestedIdentifier(
  objectName: String,
  fieldName: String,
): String {
  val nested =
    this[objectName] as? JsonObject
      ?: throw ProtocolDecodeException("invalid_field", "required object field is missing or invalid: $objectName")
  return nested.requiredIdentifier(fieldName)
}

private fun JsonObject.requiredNonNegativeInt(name: String): Int {
  val value =
    (this[name] as? JsonPrimitive)?.intOrNull
      ?: throw ProtocolDecodeException("invalid_field", "required integer field is missing or invalid: $name")
  if (value < 0) {
    throw ProtocolDecodeException("invalid_field", "required integer field is negative: $name")
  }
  return value
}
