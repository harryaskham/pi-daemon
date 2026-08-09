package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.DashboardInventoryPage
import com.harryaskham.pidroid.sdk.core.DashboardInventoryRecord
import com.harryaskham.pidroid.sdk.core.DashboardSessionInfo
import com.harryaskham.pidroid.sdk.core.DashboardTranscript
import com.harryaskham.pidroid.sdk.core.TranscriptAvailabilityState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Projects decoded sdk-core lifecycle resources into the existing bounded Rich session surface. */
public object SessionLifecycleProjection {
  private const val MAX_BLOCKS_PER_RECORD: Int = 128

  public fun project(
    host: SessionHostContext,
    inventory: DashboardInventoryPage,
    info: DashboardSessionInfo,
    transcript: DashboardTranscript,
    maxRetainedRecords: Int = 500,
    maxContentChars: Int = 16_384,
  ): SessionSurfaceState {
    require(maxRetainedRecords in 1..5_000) { "retained transcript bound is invalid" }
    require(maxContentChars in 1..65_536) { "transcript content bound is invalid" }
    require(inventory.sessions.any { it.inventoryId == info.session.inventoryId }) {
      "session information is absent from inventory"
    }
    require(transcript.inventoryId == info.session.inventoryId) {
      "transcript does not match session information"
    }
    if (transcript.availability == TranscriptAvailabilityState.UNAVAILABLE && transcript.records.isNotEmpty()) {
      throw SessionFixtureException("invalid_transcript", "unavailable transcript cannot contain records")
    }
    val runtimeModel = (info.runtime?.get("model") as? JsonObject)
    val records = decodeRecords(transcript.records, maxRetainedRecords, maxContentChars)
    return SessionSurfaceState(
      host = host,
      inventory = inventory.sessions.map(::inventoryItem),
      session =
        SessionInfoModel(
          inventoryId = info.session.inventoryId,
          title = info.session.title,
          projectLabel = info.session.projectLabel,
          sessionId =
            info.session.managed
              ?.key
              ?.sessionId,
          generation =
            info.session.managed
              ?.key
              ?.generation,
          revision = info.session.managed?.revision,
          state = info.session.managed?.state ?: info.session.presence.runtime,
          modelLabel = runtimeModel?.boundedOptionalString("id", 256),
          thinkingLevel = runtimeModel?.boundedOptionalString("thinkingLevel", 64),
          messageCount = info.session.messageCount,
          toolCallCount = info.session.toolCallCount ?: 0,
        ),
      records = records,
      mode = SessionSurfaceMode.READONLY,
      freshnessLabel = SessionSurfaceReducer.freshnessLabel(host.freshness, host.observedAgeMillis),
      canMutate = false,
      retainedRecordLimit = maxRetainedRecords,
    )
  }

  private fun inventoryItem(record: DashboardInventoryRecord): SessionInventoryItem =
    SessionInventoryItem(
      inventoryId = record.inventoryId,
      title = record.title,
      projectLabel = record.projectLabel,
      sessionId = record.managed?.key?.sessionId,
      generation = record.managed?.key?.generation,
      state = record.managed?.state ?: record.presence.runtime,
      unread = record.presence.unread,
    )

  private fun decodeRecords(
    records: JsonArray,
    maxRetainedRecords: Int,
    maxContentChars: Int,
  ): List<TranscriptRecord> {
    val stable = linkedMapOf<StableRecordKey, TranscriptRecord>()
    for (element in records) {
      val record =
        element as? JsonObject
          ?: throw SessionFixtureException("invalid_transcript", "transcript record is invalid")
      val key = StableRecordKey(record.boundedRequiredString("recordId", 256))
      val kind = record.boundedRequiredString("kind", 128)
      val role = decodeRole(record.boundedOptionalString("role", 64), kind)
      val content = record["content"] as? JsonArray ?: JsonArray(emptyList())
      if (content.size > MAX_BLOCKS_PER_RECORD) {
        throw SessionFixtureException("record_too_large", "transcript record exceeds the block bound")
      }
      stable[key] =
        TranscriptRecord(
          key = key,
          kind = kind,
          role = role,
          state = record.boundedOptionalString("state", 64) ?: "complete",
          blocks = content.map { decodeBlock(it, maxContentChars) },
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
    val wireType = block.boundedRequiredString("type", 64)
    val rawText = (block["text"] as? JsonPrimitive)?.contentOrNull ?: ""
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

private fun JsonObject.boundedRequiredString(
  name: String,
  maximum: Int,
): String =
  (this[name] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= maximum }
    ?: throw SessionFixtureException("invalid_field", "required lifecycle field is invalid: $name")

private fun JsonObject.boundedOptionalString(
  name: String,
  maximum: Int,
): String? {
  val element = this[name] ?: return null
  return (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= maximum }
    ?: throw SessionFixtureException("invalid_field", "optional lifecycle field is invalid: $name")
}
