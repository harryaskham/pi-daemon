package com.harryaskham.pidroid.sdk.core

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/**
 * Strict content-free process persistence for [SessionLifecycleCoordinator].
 *
 * The embedding application owns atomic storage and deletion. This codec deliberately has no
 * credential, cwd, prompt, transcript, command body, result, or arbitrary error fields. Restoring a
 * decoded snapshot still converts every in-flight command to indeterminate and never replays it.
 */
public object SessionResumeSnapshotCodec {
  private const val MAX_SNAPSHOT_BYTES: Int = 1_048_576
  private const val MAX_IDENTITIES: Int = 2_048

  public fun encode(snapshot: SessionResumeSnapshot): ByteArray {
    require(snapshot.formatVersion == 1) { "resume snapshot format is unsupported" }
    require(snapshot.usedConnectionAttempts.size <= MAX_IDENTITIES) { "resume connection identity bound exceeded" }
    require(snapshot.issuedRequests.size <= MAX_IDENTITIES) { "resume request identity bound exceeded" }
    require(snapshot.commands.size <= MAX_IDENTITIES) { "resume command identity bound exceeded" }
    require(snapshot.tickets.size <= MAX_IDENTITIES) { "resume ticket identity bound exceeded" }

    val root =
      JsonObject(
        linkedMapOf(
          "formatVersion" to JsonPrimitive(snapshot.formatVersion),
          "hostId" to JsonPrimitive(snapshot.hostId.value),
          "hostInstanceId" to snapshot.hostInstanceId.jsonStringOrNull(),
          "session" to snapshot.session.toJson(),
          "replayCursor" to snapshot.replayCursor.jsonStringOrNull(),
          "usedConnectionAttempts" to
            JsonArray(snapshot.usedConnectionAttempts.map { JsonPrimitive(it.value) }),
          "issuedRequests" to JsonArray(snapshot.issuedRequests.map(DurableRequestIdentity::toJson)),
          "commands" to JsonArray(snapshot.commands.map(ResumableCommand::toJson)),
          "tickets" to JsonArray(snapshot.tickets.map(ResumableTicket::toJson)),
        ),
      )
    val encoded = root.toString().encodeToByteArray()
    require(encoded.size <= MAX_SNAPSHOT_BYTES) { "resume snapshot exceeds the byte bound" }
    return encoded
  }

  public fun decode(bytes: ByteArray): SessionResumeSnapshot {
    if (bytes.isEmpty() || bytes.size > MAX_SNAPSHOT_BYTES) {
      throw ProtocolDecodeException("invalid_resume_snapshot", "resume snapshot size is invalid")
    }
    return try {
      decodeRoot(Json.parseToJsonElement(decodeUtf8(bytes)).snapshotObject("resume snapshot"))
    } catch (error: ProtocolDecodeException) {
      throw error
    } catch (error: Exception) {
      throw ProtocolDecodeException("invalid_resume_snapshot", "resume snapshot is malformed")
    }
  }

  private fun decodeRoot(root: JsonObject): SessionResumeSnapshot {
    root.requireOnly(
      setOf(
        "formatVersion",
        "hostId",
        "hostInstanceId",
        "session",
        "replayCursor",
        "usedConnectionAttempts",
        "issuedRequests",
        "commands",
        "tickets",
      ),
      "resume snapshot",
    )
    val formatVersion = root.snapshotRequiredInt("formatVersion")
    if (formatVersion != 1) {
      throw ProtocolDecodeException("unsupported_resume_snapshot", "resume snapshot format is unsupported")
    }
    val attempts =
      root.snapshotArray("usedConnectionAttempts").map { element ->
        ConnectionAttemptId(element.snapshotString("connection attempt ID", 128))
      }
    requireUnique(attempts.map(ConnectionAttemptId::value), "connection attempt")

    val requests = root.snapshotArray("issuedRequests").map(::decodeRequest)
    requireUnique(requests.map(DurableRequestIdentity::requestId), "request")
    requireUnique(requests.map(DurableRequestIdentity::idempotencyKey), "idempotency")

    val commands = root.snapshotArray("commands").map(::decodeCommand)
    requireUnique(commands.map { it.correlationId.value }, "command")

    val tickets = root.snapshotArray("tickets").map(::decodeTicket)
    requireUnique(tickets.map(ResumableTicket::ticketId), "ticket")
    if (tickets.any { it.request !in requests }) {
      throw ProtocolDecodeException("invalid_resume_snapshot", "ticket request identity is absent")
    }

    return SessionResumeSnapshot(
      formatVersion = formatVersion,
      hostId = HostId(root.snapshotRequiredString("hostId", 128)),
      hostInstanceId = root.snapshotOptionalString("hostInstanceId", 128),
      session = decodeSession(root.getValue("session")),
      replayCursor = root.snapshotOptionalString("replayCursor", 1_024),
      usedConnectionAttempts = attempts.toSet(),
      issuedRequests = requests.toSet(),
      commands = commands,
      tickets = tickets,
    )
  }

  private fun decodeRequest(element: JsonElement): DurableRequestIdentity {
    val value = element.snapshotObject("request identity")
    value.requireOnly(setOf("requestId", "idempotencyKey"), "request identity")
    return DurableRequestIdentity(
      requestId = value.snapshotRequiredString("requestId", 128),
      idempotencyKey = value.snapshotRequiredString("idempotencyKey", 512),
    )
  }

  private fun decodeCommand(element: JsonElement): ResumableCommand {
    val value = element.snapshotObject("resumable command")
    value.requireOnly(setOf("correlationId", "kind", "lifecycle"), "resumable command")
    val kind =
      PiRpcCommandType.fromWireValue(value.snapshotRequiredString("kind", 64))
        ?: throw ProtocolDecodeException("invalid_resume_snapshot", "resume command kind is unsupported")
    val lifecycle =
      runCatching { CommandLifecycle.valueOf(value.snapshotRequiredString("lifecycle", 32)) }
        .getOrNull()
        ?: throw ProtocolDecodeException("invalid_resume_snapshot", "resume command lifecycle is unsupported")
    return ResumableCommand(
      correlationId = CorrelationId(value.snapshotRequiredString("correlationId", 128)),
      kind = kind,
      lifecycle = lifecycle,
    )
  }

  private fun decodeTicket(element: JsonElement): ResumableTicket {
    val value = element.snapshotObject("resumable ticket")
    value.requireOnly(setOf("ticketId", "request", "state", "session"), "resumable ticket")
    val state =
      TicketState.fromWireValue(value.snapshotRequiredString("state", 32))
        ?: throw ProtocolDecodeException("invalid_resume_snapshot", "resume ticket state is unsupported")
    return ResumableTicket(
      ticketId = value.snapshotRequiredString("ticketId", 256),
      request = decodeRequest(value.getValue("request")),
      state = state,
      session = value["session"].takeUnless { it == null || it == JsonNull }?.let(::decodeSession),
    )
  }

  private fun decodeSession(element: JsonElement): SessionKey {
    val value = element.snapshotObject("session identity")
    value.requireOnly(setOf("sessionId", "generation"), "session identity")
    return SessionKey(
      sessionId = value.snapshotRequiredString("sessionId", 128),
      generation = value.snapshotRequiredInt("generation"),
    )
  }

  private fun decodeUtf8(bytes: ByteArray): String =
    StandardCharsets.UTF_8
      .newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes))
      .toString()

  private fun requireUnique(
    values: List<String>,
    label: String,
  ) {
    if (values.size != values.toSet().size) {
      throw ProtocolDecodeException("invalid_resume_snapshot", "$label identities are duplicated")
    }
  }

  private fun JsonObject.snapshotArray(name: String): JsonArray {
    val value =
      this[name] as? JsonArray
        ?: throw ProtocolDecodeException("invalid_resume_snapshot", "resume array is missing or invalid: $name")
    if (value.size > MAX_IDENTITIES) {
      throw ProtocolDecodeException("invalid_resume_snapshot", "resume array exceeds the identity bound: $name")
    }
    return value
  }
}

private fun String?.jsonStringOrNull(): JsonElement = this?.let(::JsonPrimitive) ?: JsonNull

private fun SessionKey.toJson(): JsonObject =
  JsonObject(
    linkedMapOf(
      "sessionId" to JsonPrimitive(sessionId),
      "generation" to JsonPrimitive(generation),
    ),
  )

private fun DurableRequestIdentity.toJson(): JsonObject =
  JsonObject(
    linkedMapOf(
      "requestId" to JsonPrimitive(requestId),
      "idempotencyKey" to JsonPrimitive(idempotencyKey),
    ),
  )

private fun ResumableCommand.toJson(): JsonObject =
  JsonObject(
    linkedMapOf(
      "correlationId" to JsonPrimitive(correlationId.value),
      "kind" to JsonPrimitive(kind.wireValue),
      "lifecycle" to JsonPrimitive(lifecycle.name),
    ),
  )

private fun ResumableTicket.toJson(): JsonObject =
  JsonObject(
    linkedMapOf(
      "ticketId" to JsonPrimitive(ticketId),
      "request" to request.toJson(),
      "state" to JsonPrimitive(state.wireValue),
      "session" to (session?.toJson() ?: JsonNull),
    ),
  )

private fun JsonElement.snapshotObject(label: String): JsonObject =
  this as? JsonObject
    ?: throw ProtocolDecodeException("invalid_resume_snapshot", "$label must be an object")

private fun JsonElement.snapshotString(
  label: String,
  maximum: Int,
): String {
  val primitive = this as? JsonPrimitive
  val value = primitive?.takeIf(JsonPrimitive::isString)?.contentOrNull
  return value?.takeIf {
    it.isNotEmpty() && it.length <= maximum && '\r' !in it && '\n' !in it && '\u0000' !in it
  } ?: throw ProtocolDecodeException("invalid_resume_snapshot", "$label is invalid")
}

private fun JsonObject.snapshotRequiredString(
  name: String,
  maximum: Int,
): String =
  this[name]?.snapshotString(name, maximum)
    ?: throw ProtocolDecodeException("invalid_resume_snapshot", "resume string is missing: $name")

private fun JsonObject.snapshotOptionalString(
  name: String,
  maximum: Int,
): String? =
  when (val value = this[name]) {
    null, JsonNull -> null
    else -> value.snapshotString(name, maximum)
  }

private fun JsonObject.snapshotRequiredInt(name: String): Int {
  val value =
    (this[name] as? JsonPrimitive)?.intOrNull
      ?: throw ProtocolDecodeException("invalid_resume_snapshot", "resume integer is missing or invalid: $name")
  if (value < 0) throw ProtocolDecodeException("invalid_resume_snapshot", "resume integer is negative: $name")
  return value
}

private fun JsonObject.requireOnly(
  fields: Set<String>,
  label: String,
) {
  if (keys != fields) {
    throw ProtocolDecodeException("invalid_resume_snapshot", "$label fields are invalid")
  }
}
