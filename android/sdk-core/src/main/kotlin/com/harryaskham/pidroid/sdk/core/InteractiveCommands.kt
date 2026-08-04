package com.harryaskham.pidroid.sdk.core

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@JvmInline
public value class CorrelationId(
  public val value: String,
) {
  init {
    require(value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) {
      "command correlation ID must be a bounded identifier"
    }
  }
}

public sealed class SessionCommandIntent protected constructor(
  public val kind: PiRpcCommandType,
) {
  internal abstract fun fields(): Map<String, kotlinx.serialization.json.JsonElement>

  override fun toString(): String = "SessionCommandIntent(kind=${kind.wireValue}, content=[REDACTED])"

  private class MessageIntent(
    kind: PiRpcCommandType,
    private val message: String,
  ) : SessionCommandIntent(kind) {
    override fun fields(): Map<String, kotlinx.serialization.json.JsonElement> =
      linkedMapOf(
        "type" to JsonPrimitive(kind.wireValue),
        "message" to JsonPrimitive(message),
      )
  }

  private class EmptyIntent(
    kind: PiRpcCommandType,
  ) : SessionCommandIntent(kind) {
    override fun fields(): Map<String, kotlinx.serialization.json.JsonElement> = linkedMapOf("type" to JsonPrimitive(kind.wireValue))
  }

  private class ModelIntent(
    private val provider: String,
    private val modelId: String,
  ) : SessionCommandIntent(PiRpcCommandType.SET_MODEL) {
    override fun fields(): Map<String, kotlinx.serialization.json.JsonElement> =
      linkedMapOf(
        "type" to JsonPrimitive(kind.wireValue),
        "provider" to JsonPrimitive(provider),
        "modelId" to JsonPrimitive(modelId),
      )
  }

  private class ThinkingIntent(
    private val level: String,
  ) : SessionCommandIntent(PiRpcCommandType.SET_THINKING_LEVEL) {
    override fun fields(): Map<String, kotlinx.serialization.json.JsonElement> =
      linkedMapOf(
        "type" to JsonPrimitive(kind.wireValue),
        "level" to JsonPrimitive(level),
      )
  }

  private class CompactIntent(
    private val instructions: String,
  ) : SessionCommandIntent(PiRpcCommandType.COMPACT) {
    override fun fields(): Map<String, kotlinx.serialization.json.JsonElement> =
      linkedMapOf(
        "type" to JsonPrimitive(kind.wireValue),
        "customInstructions" to JsonPrimitive(instructions),
      )
  }

  public companion object {
    public fun prompt(message: String): SessionCommandIntent = MessageIntent(PiRpcCommandType.PROMPT, boundedContent(message, "prompt"))

    public fun steer(message: String): SessionCommandIntent = MessageIntent(PiRpcCommandType.STEER, boundedContent(message, "steer"))

    public fun followUp(message: String): SessionCommandIntent =
      MessageIntent(PiRpcCommandType.FOLLOW_UP, boundedContent(message, "follow-up"))

    public fun abort(): SessionCommandIntent = EmptyIntent(PiRpcCommandType.ABORT)

    public fun getTree(): SessionCommandIntent = EmptyIntent(PiRpcCommandType.GET_TREE)

    public fun setModel(
      provider: String,
      modelId: String,
    ): SessionCommandIntent {
      requireWireValue(provider, "model provider")
      requireWireValue(modelId, "model ID")
      return ModelIntent(provider, modelId)
    }

    public fun setThinkingLevel(level: String): SessionCommandIntent {
      requireWireValue(level, "thinking level")
      return ThinkingIntent(level)
    }

    public fun compact(customInstructions: String): SessionCommandIntent =
      CompactIntent(boundedContent(customInstructions, "compaction instructions"))

    private fun boundedContent(
      value: String,
      label: String,
    ): String {
      require(value.isNotBlank() && value.length <= 65_536 && '\u0000' !in value) {
        "$label is empty, invalid, or too long"
      }
      return value
    }

    private fun requireWireValue(
      value: String,
      label: String,
    ) {
      require(value.isNotBlank() && value.length <= 256 && value.none { it.isISOControl() }) {
        "$label is invalid or too long"
      }
    }
  }
}

/** Encodes one content-bearing command. The returned wire text is sensitive and must not be logged. */
public object InteractiveCommandCodec {
  public fun encode(
    intent: SessionCommandIntent,
    correlationId: CorrelationId,
  ): String {
    val command = linkedMapOf<String, kotlinx.serialization.json.JsonElement>()
    command["id"] = JsonPrimitive(correlationId.value)
    command.putAll(intent.fields())
    return JsonObject(
      linkedMapOf(
        "kind" to JsonPrimitive("command"),
        "command" to JsonObject(command),
      ),
    ).toString()
  }
}

public data class InteractiveCapabilities(
  public val commands: Set<PiRpcCommandType>,
  public val schedules: Boolean,
) {
  public companion object {
    public fun from(capabilities: HostCapabilities): InteractiveCapabilities {
      val rpc = capabilities.additionalFields["rpc"] as? JsonObject
      val host = rpc?.get("host") as? JsonObject
      val commandTypes = host?.get("commandTypes") as? JsonArray ?: JsonArray(emptyList())
      val commands =
        commandTypes.mapNotNullTo(linkedSetOf()) { element ->
          (element as? JsonPrimitive)?.content?.let(PiRpcCommandType::fromWireValue)
        }
      return InteractiveCapabilities(
        commands = commands,
        schedules = capabilities.additionalFields["schedules"] is JsonObject,
      )
    }
  }
}

/** No-runtime draft identity. Only [materialize] records an externally accepted first-send result. */
public class LazySessionDraft private constructor(
  public val draftId: String,
  public val name: String,
  public val projectLabel: String?,
  public val session: SessionKey?,
  public val firstSendIdempotencyKey: String?,
) {
  public val materialized: Boolean
    get() = session != null

  public fun materialize(
    session: SessionKey,
    firstSendIdempotencyKey: String,
  ): LazySessionDraft {
    check(!materialized) { "draft is already materialized" }
    require(firstSendIdempotencyKey.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$"))) {
      "first-send idempotency key is invalid"
    }
    return LazySessionDraft(draftId, name, projectLabel, session, firstSendIdempotencyKey)
  }

  override fun toString(): String =
    "LazySessionDraft(draftId=$draftId, name=$name, projectLabel=$projectLabel, materialized=$materialized, firstSend=[REDACTED])"

  public companion object {
    public fun create(
      draftId: String,
      name: String,
      projectLabel: String? = null,
    ): LazySessionDraft {
      require(draftId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) { "draft ID is invalid" }
      require(name.isNotBlank() && name.length <= 128 && name.none { it.isISOControl() }) { "draft name is invalid" }
      require(projectLabel == null || (projectLabel.isNotBlank() && projectLabel.length <= 128)) {
        "draft project label is invalid"
      }
      return LazySessionDraft(draftId, name, projectLabel, session = null, firstSendIdempotencyKey = null)
    }
  }
}
