package com.harryaskham.pidroid.androidui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

public enum class WidgetMode {
  STATUS,
  TRANSCRIPT_TAIL,
  INTERACTIVE,
  COLLECTION,
}

/** Persistable widget selection. It contains local identity only, never authority or credentials. */
public data class WidgetSelection(
  public val session: SavedSessionSelection,
  public val mode: WidgetMode,
)

public object WidgetSelectionCodec {
  private const val VERSION = "widget-v1"

  public fun encode(selection: WidgetSelection): String =
    listOf(
      VERSION,
      encodeComponent(selection.session.hostId.value),
      encodeComponent(selection.session.sessionId),
      selection.mode.name,
    ).joinToString("|")

  public fun decode(encoded: String): WidgetSelection? =
    runCatching {
      require(encoded.length <= 1_024 && '\r' !in encoded && '\n' !in encoded)
      val parts = encoded.split('|')
      require(parts.size == 4 && parts[0] == VERSION)
      WidgetSelection(
        session = SavedSessionSelection.from(parts[1].decodeComponent(), parts[2].decodeComponent()),
        mode = WidgetMode.valueOf(parts[3]),
      )
    }.getOrNull()

  private fun String.decodeComponent(): String = URLDecoder.decode(this, StandardCharsets.UTF_8)

  private fun encodeComponent(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8)
}

public enum class WidgetAction {
  OPEN,
  WAKE,
  FOLLOW_UP,
  ABORT,
}

public enum class WidgetActionDecision {
  OPEN_APP,
  DISABLED,
  REQUIRES_FRESH_REVALIDATION,
  READY,
}

public class WidgetProjection internal constructor(
  public val selection: WidgetSelection,
  public val hostLabel: String,
  public val sessionLabel: String,
  public val freshness: CacheFreshness,
  public val observedAgeMillis: Long,
  public val freshnessLabel: String,
  public val stale: Boolean,
  public val interactiveOptIn: Boolean,
  private val projectedAtMillis: Long,
) {
  public fun decide(
    action: WidgetAction,
    revalidatedAtMillis: Long?,
  ): WidgetActionDecision {
    if (action == WidgetAction.OPEN) return WidgetActionDecision.OPEN_APP
    if (selection.mode != WidgetMode.INTERACTIVE || !interactiveOptIn) return WidgetActionDecision.DISABLED
    if (stale) return WidgetActionDecision.REQUIRES_FRESH_REVALIDATION
    val revalidated = revalidatedAtMillis ?: return WidgetActionDecision.REQUIRES_FRESH_REVALIDATION
    if (revalidated > projectedAtMillis || projectedAtMillis - revalidated > REVALIDATION_WINDOW_MILLIS) {
      return WidgetActionDecision.REQUIRES_FRESH_REVALIDATION
    }
    return WidgetActionDecision.READY
  }

  override fun toString(): String =
    "WidgetProjection(selection=$selection, freshness=$freshness, ageMillis=$observedAgeMillis, stale=$stale, labels=[REDACTED])"

  private companion object {
    const val REVALIDATION_WINDOW_MILLIS: Long = 30_000
  }
}

public class WidgetCollectionProjection internal constructor(
  projections: List<WidgetProjection>,
) {
  public val projections: List<WidgetProjection> = projections.toList()
  public val staleCount: Int = projections.count(WidgetProjection::stale)
  public val allFresh: Boolean = projections.isNotEmpty() && staleCount == 0

  init {
    require(this.projections.size in 1..MAX_COLLECTION_ITEMS) { "widget collection size is invalid" }
  }

  override fun toString(): String = "WidgetCollectionProjection(items=${projections.size}, stale=$staleCount, content=[REDACTED])"

  public companion object {
    public const val MAX_COLLECTION_ITEMS: Int = 8
  }
}

public object WidgetProjectionPolicy {
  public fun project(
    selection: WidgetSelection,
    hostLabel: String,
    sessionLabel: String,
    freshness: CacheFreshness,
    observedAtMillis: Long,
    nowMillis: Long,
    staleAfterMillis: Long,
    interactiveOptIn: Boolean,
  ): WidgetProjection {
    require(hostLabel.isNotBlank() && hostLabel.length <= 128) { "widget host label is invalid" }
    require(sessionLabel.isNotBlank() && sessionLabel.length <= 128) { "widget session label is invalid" }
    require(observedAtMillis in 0..nowMillis) { "widget observation time is invalid" }
    require(staleAfterMillis > 0) { "widget stale bound must be positive" }
    val age = nowMillis - observedAtMillis
    val stale = freshness != CacheFreshness.FRESH || age > staleAfterMillis
    return WidgetProjection(
      selection = selection,
      hostLabel = hostLabel,
      sessionLabel = sessionLabel,
      freshness = freshness,
      observedAgeMillis = age,
      freshnessLabel = freshnessLabel(freshness, age, stale),
      stale = stale,
      interactiveOptIn = interactiveOptIn,
      projectedAtMillis = nowMillis,
    )
  }

  public fun collection(projections: List<WidgetProjection>): WidgetCollectionProjection = WidgetCollectionProjection(projections)

  private fun freshnessLabel(
    freshness: CacheFreshness,
    ageMillis: Long,
    stale: Boolean,
  ): String {
    val age = ageLabel(ageMillis)
    if (stale && freshness == CacheFreshness.FRESH) return "Stale · $age"
    val state =
      when (freshness) {
        CacheFreshness.FRESH -> "Live"
        CacheFreshness.RECONNECTING -> "Reconnecting"
        CacheFreshness.STALE -> "Stale"
        CacheFreshness.RESYNCING -> "Resyncing"
        CacheFreshness.OFFLINE_CACHED -> "Offline"
        CacheFreshness.REMOVED -> "Removed"
      }
    return "$state · $age"
  }

  private fun ageLabel(ageMillis: Long): String =
    when {
      ageMillis < 60_000 -> "now"
      ageMillis < 60 * 60_000 -> "${ageMillis / 60_000}m"
      else -> "${ageMillis / (60 * 60_000)}h"
    }
}
