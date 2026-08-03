package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId

public data class SessionHostContext(
  public val hostId: HostId,
  public val displayName: String,
  public val authority: HostAuthority,
  public val freshness: CacheFreshness,
  public val observedAgeMillis: Long,
) {
  init {
    require(authority.hostId == hostId) { "host authority must match host identity" }
    require(displayName.isNotBlank() && displayName.length <= 128) { "host display name is invalid" }
    require(observedAgeMillis >= 0) { "observed age must be non-negative" }
  }
}

@JvmInline
public value class StableRecordKey(
  public val value: String,
) {
  init {
    require(value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"))) {
      "transcript record key must be a bounded stable identifier"
    }
  }
}

public enum class TranscriptRole(
  public val wireValue: String,
) {
  USER("user"),
  ASSISTANT("assistant"),
  TOOL("tool"),
  SYSTEM("system"),
  UNKNOWN("unknown"),
}

public enum class TranscriptBlockType {
  TEXT,
  MARKDOWN,
  CODE,
  STATUS,
  UNKNOWN,
}

public class TranscriptBlock(
  public val type: TranscriptBlockType,
  public val text: String,
  public val truncated: Boolean,
) {
  override fun toString(): String = "TranscriptBlock(type=$type, chars=${text.length}, truncated=$truncated, content=[REDACTED])"
}

public class TranscriptRecord(
  public val key: StableRecordKey,
  public val kind: String,
  public val role: TranscriptRole,
  public val state: String,
  public val blocks: List<TranscriptBlock>,
) {
  override fun toString(): String =
    "TranscriptRecord(key=${key.value}, kind=$kind, role=$role, state=$state, blocks=${blocks.size}, content=[REDACTED])"
}

public data class SessionInventoryItem(
  public val inventoryId: String,
  public val title: String,
  public val projectLabel: String?,
  public val sessionId: String?,
  public val generation: Int?,
  public val state: String,
  public val unread: Boolean,
)

public data class SessionInfoModel(
  public val inventoryId: String,
  public val title: String,
  public val projectLabel: String?,
  public val sessionId: String?,
  public val generation: Int?,
  public val revision: Int?,
  public val state: String,
  public val modelLabel: String?,
  public val thinkingLevel: String?,
  public val messageCount: Int,
  public val toolCallCount: Int,
)

public enum class SessionSurfaceMode {
  READONLY,
}

public class SessionSurfaceState(
  public val host: SessionHostContext,
  public val inventory: List<SessionInventoryItem>,
  public val session: SessionInfoModel,
  public val records: List<TranscriptRecord>,
  public val mode: SessionSurfaceMode,
  public val freshnessLabel: String,
  public val canMutate: Boolean,
  public val retainedRecordLimit: Int,
) {
  init {
    require(mode == SessionSurfaceMode.READONLY && !canMutate) {
      "Stage B session surface must remain readonly"
    }
    require(records.size <= retainedRecordLimit) { "transcript exceeds retained record bound" }
  }

  override fun toString(): String =
    "SessionSurfaceState(host=${host.hostId.value}, session=${session.inventoryId}, inventory=${inventory.size}, records=${records.size}, mode=$mode, freshness=${host.freshness}, content=[REDACTED])"
}
