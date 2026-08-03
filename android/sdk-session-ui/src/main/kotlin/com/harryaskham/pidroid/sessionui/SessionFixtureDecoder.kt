package com.harryaskham.pidroid.sessionui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

public class SessionFixtureException(
  public val code: String,
  message: String,
) : IllegalArgumentException(message)

/**
 * Fixture-backed projection used by the Stage B readonly surface. It admits only bounded neutral
 * service envelopes and intentionally ignores canonical paths, ownership/controller fields,
 * credentials, command capabilities, and other Stage C authority.
 */
public object SessionFixtureDecoder {
  private const val MAX_ENVELOPE_CHARS: Int = 4 * 1_024 * 1_024
  private const val MAX_INVENTORY_ITEMS: Int = 2_048
  private const val MAX_BLOCKS_PER_RECORD: Int = 128
  private val json: Json = Json

  public fun decode(
    host: SessionHostContext,
    inventoryEnvelope: String,
    infoEnvelope: String,
    transcriptEnvelope: String,
    maxRetainedRecords: Int = 500,
    maxContentChars: Int = 16_384,
  ): SessionSurfaceState {
    require(maxRetainedRecords in 1..5_000) { "retained transcript bound is invalid" }
    require(maxContentChars in 1..65_536) { "transcript content bound is invalid" }
    val inventoryData = decodeEnvelope(host, inventoryEnvelope, "inventory")
    val infoData = decodeEnvelope(host, infoEnvelope, "information")
    val transcriptData = decodeEnvelope(host, transcriptEnvelope, "transcript")
    val inventory = decodeInventory(inventoryData)
    val info = decodeInfo(infoData)
    require(inventory.any { it.inventoryId == info.inventoryId }) {
      "session information is absent from the inventory fixture"
    }
    require(transcriptData.requiredString("inventoryId") == info.inventoryId) {
      "transcript fixture does not match session information"
    }
    val records = decodeRecords(transcriptData, maxRetainedRecords, maxContentChars)
    return SessionSurfaceState(
      host = host,
      inventory = inventory,
      session = info,
      records = records,
      mode = SessionSurfaceMode.READONLY,
      freshnessLabel = SessionSurfaceReducer.freshnessLabel(host.freshness, host.observedAgeMillis),
      canMutate = false,
      retainedRecordLimit = maxRetainedRecords,
    )
  }

  private fun decodeEnvelope(
    host: SessionHostContext,
    text: String,
    label: String,
  ): JsonObject {
    if (text.length > MAX_ENVELOPE_CHARS) {
      throw SessionFixtureException("message_too_large", "$label fixture exceeds the safety bound")
    }
    val root =
      try {
        json.parseToJsonElement(text) as? JsonObject
      } catch (_: Exception) {
        null
      } ?: throw SessionFixtureException("invalid_json", "$label fixture is not a JSON object")
    if (root.requiredString("apiVersion") != "1.0" || !root.requiredBoolean("ok")) {
      throw SessionFixtureException("invalid_envelope", "$label fixture envelope is unsupported")
    }
    if (root.requiredString("hostInstanceId") != host.authority.hostInstanceId) {
      throw SessionFixtureException("host_replaced", "$label fixture belongs to another host incarnation")
    }
    return root["data"] as? JsonObject
      ?: throw SessionFixtureException("missing_data", "$label fixture is missing data")
  }

  private fun decodeInventory(data: JsonObject): List<SessionInventoryItem> {
    val sessions =
      data["sessions"] as? JsonArray
        ?: throw SessionFixtureException("invalid_inventory", "inventory fixture is missing sessions")
    if (sessions.size > MAX_INVENTORY_ITEMS) {
      throw SessionFixtureException("inventory_too_large", "inventory fixture exceeds the item bound")
    }
    return sessions.map { element ->
      val item =
        element as? JsonObject
          ?: throw SessionFixtureException("invalid_inventory", "inventory session is invalid")
      val managed = item["managed"] as? JsonObject
      val presence = item["presence"] as? JsonObject
      SessionInventoryItem(
        inventoryId = item.requiredString("inventoryId"),
        title = item.requiredString("title"),
        projectLabel = item.optionalString("projectLabel"),
        sessionId = managed?.optionalString("sessionId"),
        generation = managed?.optionalNonNegativeInt("generation"),
        state = managed?.optionalString("state") ?: presence?.optionalString("runtime") ?: "retained",
        unread = presence?.optionalBoolean("unread") ?: false,
      )
    }
  }

  private fun decodeInfo(data: JsonObject): SessionInfoModel {
    val managed = data["managed"] as? JsonObject
    val runtime = data["runtime"] as? JsonObject
    val model = runtime?.get("model") as? JsonObject
    return SessionInfoModel(
      inventoryId = data.requiredString("inventoryId"),
      title = data.requiredString("title"),
      projectLabel = data.optionalString("projectLabel"),
      sessionId = managed?.optionalString("sessionId"),
      generation = managed?.optionalNonNegativeInt("generation"),
      revision = managed?.optionalNonNegativeInt("revision"),
      state = managed?.optionalString("state") ?: "retained",
      modelLabel = model?.optionalString("id"),
      thinkingLevel = model?.optionalString("thinkingLevel"),
      messageCount = data.optionalNonNegativeInt("messageCount") ?: 0,
      toolCallCount = data.optionalNonNegativeInt("toolCallCount") ?: 0,
    )
  }

  private fun decodeRecords(
    data: JsonObject,
    maxRetainedRecords: Int,
    maxContentChars: Int,
  ): List<TranscriptRecord> {
    val records =
      data["records"] as? JsonArray
        ?: throw SessionFixtureException("invalid_transcript", "transcript fixture is missing records")
    if (records.size > 50_000) {
      throw SessionFixtureException("transcript_too_large", "transcript fixture exceeds the record bound")
    }
    val stable = linkedMapOf<StableRecordKey, TranscriptRecord>()
    for (element in records) {
      val record =
        element as? JsonObject
          ?: throw SessionFixtureException("invalid_transcript", "transcript record is invalid")
      val key = StableRecordKey(record.requiredString("recordId"))
      val kind = record.requiredString("kind")
      val role = decodeRole(record.optionalString("role"), kind)
      val content = record["content"] as? JsonArray ?: JsonArray(emptyList())
      if (content.size > MAX_BLOCKS_PER_RECORD) {
        throw SessionFixtureException("record_too_large", "transcript record exceeds the block bound")
      }
      val blocks = content.map { decodeBlock(it, maxContentChars) }
      stable[key] =
        TranscriptRecord(
          key = key,
          kind = kind,
          role = role,
          state = record.optionalString("state") ?: "complete",
          blocks = blocks,
        )
    }
    return stable.values.toList().takeLast(maxRetainedRecords)
  }

  private fun decodeRole(
    role: String?,
    kind: String,
  ): TranscriptRole =
    when {
      kind == "tool" -> TranscriptRole.TOOL
      role == "user" -> TranscriptRole.USER
      role == "assistant" -> TranscriptRole.ASSISTANT
      role == "system" -> TranscriptRole.SYSTEM
      else -> TranscriptRole.UNKNOWN
    }

  private fun decodeBlock(
    element: JsonElement,
    maxContentChars: Int,
  ): TranscriptBlock {
    val block =
      element as? JsonObject
        ?: throw SessionFixtureException("invalid_block", "transcript content block is invalid")
    val wireType = block.requiredString("type")
    val rawText = block.optionalStringUnbounded("text") ?: ""
    val truncated = rawText.length > maxContentChars
    return TranscriptBlock(
      type =
        when (wireType) {
          "text" -> TranscriptBlockType.TEXT
          "markdown" -> TranscriptBlockType.MARKDOWN
          "code" -> TranscriptBlockType.CODE
          "status" -> TranscriptBlockType.STATUS
          else -> TranscriptBlockType.UNKNOWN
        },
      text = if (truncated) rawText.take(maxContentChars) else rawText,
      truncated = truncated,
    )
  }
}

private fun JsonObject.requiredString(name: String): String {
  val value = (this[name] as? JsonPrimitive)?.contentOrNull
  if (value == null || value.isEmpty() || value.length > 8_192) {
    throw SessionFixtureException("invalid_field", "required fixture field is invalid: $name")
  }
  return value
}

private fun JsonObject.optionalString(name: String): String? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  return (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= 8_192 }
    ?: throw SessionFixtureException("invalid_field", "optional fixture field is invalid: $name")
}

private fun JsonObject.optionalStringUnbounded(name: String): String? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  return (element as? JsonPrimitive)?.contentOrNull
    ?: throw SessionFixtureException("invalid_field", "optional fixture content field is invalid")
}

private fun JsonObject.requiredBoolean(name: String): Boolean =
  (this[name] as? JsonPrimitive)?.booleanOrNull
    ?: throw SessionFixtureException("invalid_field", "required fixture boolean is invalid: $name")

private fun JsonObject.optionalBoolean(name: String): Boolean? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  return (element as? JsonPrimitive)?.booleanOrNull
    ?: throw SessionFixtureException("invalid_field", "optional fixture boolean is invalid: $name")
}

private fun JsonObject.optionalNonNegativeInt(name: String): Int? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  val value =
    (element as? JsonPrimitive)?.intOrNull
      ?: throw SessionFixtureException("invalid_field", "optional fixture integer is invalid: $name")
  if (value < 0) {
    throw SessionFixtureException("invalid_field", "optional fixture integer is negative: $name")
  }
  return value
}
