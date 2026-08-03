package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.CacheFreshness

public data class CatchUpCandidate(
  public val id: NotificationEventId,
  public val channel: NotificationChannel,
  public val observedAtMillis: Long,
  public val freshness: CacheFreshness,
) {
  init {
    require(observedAtMillis >= 0) { "catch-up observation time must be non-negative" }
    require(channel.contentSafe) { "catch-up channel must be content safe" }
  }
}

public fun interface CatchUpTransport {
  public fun query(): List<CatchUpCandidate>
}

public data class CatchUpConstraints(
  public val networkAvailable: Boolean,
  public val batteryNotLow: Boolean,
)

public enum class CatchUpSkipReason {
  NETWORK_UNAVAILABLE,
  BATTERY_LOW,
}

public data class CatchUpResult(
  public val notifications: List<CatchUpCandidate> = emptyList(),
  public val skipReason: CatchUpSkipReason? = null,
  public val suppressedStale: Int = 0,
  public val suppressedPolicy: Int = 0,
  public val suppressedFreshness: Int = 0,
  public val suppressedDuplicate: Int = 0,
)

/**
 * Pure WorkManager catch-up policy over an injected bounded transport.
 *
 * It does not promise delivery: only current, fresh, content-safe candidates may become a local
 * notification. Stale or disconnected cache rows are suppressed rather than presented as live.
 */
public class CatchUpWorker(
  private val transport: CatchUpTransport,
  private val dedupe: NotificationDedupeLedger,
  private val policy: NotificationPolicy,
  public val minimumIntervalMinutes: Int = MINIMUM_PERIODIC_INTERVAL_MINUTES,
  public val staleAfterMillis: Long = 5 * 60_000L,
  public val maxCandidates: Int = 256,
) {
  init {
    require(minimumIntervalMinutes >= MINIMUM_PERIODIC_INTERVAL_MINUTES) {
      "WorkManager periodic catch-up must respect the 15 minute floor"
    }
    require(staleAfterMillis > 0) { "catch-up stale bound must be positive" }
    require(maxCandidates in 1..1_024) { "catch-up candidate bound is invalid" }
  }

  public fun run(
    constraints: CatchUpConstraints,
    nowMillis: Long,
    minuteOfDay: Int,
  ): CatchUpResult {
    require(nowMillis >= 0) { "catch-up now must be non-negative" }
    if (!constraints.networkAvailable) return CatchUpResult(skipReason = CatchUpSkipReason.NETWORK_UNAVAILABLE)
    if (!constraints.batteryNotLow) return CatchUpResult(skipReason = CatchUpSkipReason.BATTERY_LOW)

    val candidates = transport.query()
    require(candidates.size <= maxCandidates) { "catch-up transport exceeded candidate bound" }
    val notifications = mutableListOf<CatchUpCandidate>()
    var stale = 0
    var policySuppressed = 0
    var freshness = 0
    var duplicate = 0

    for (candidate in candidates) {
      when {
        candidate.observedAtMillis > nowMillis || nowMillis - candidate.observedAtMillis > staleAfterMillis -> stale += 1
        candidate.freshness != CacheFreshness.FRESH -> freshness += 1
        policy.suppression(candidate.id.session, minuteOfDay) != null -> policySuppressed += 1
        !dedupe.admit(candidate.id) -> duplicate += 1
        else -> notifications += candidate
      }
    }
    return CatchUpResult(
      notifications = notifications,
      suppressedStale = stale,
      suppressedPolicy = policySuppressed,
      suppressedFreshness = freshness,
      suppressedDuplicate = duplicate,
    )
  }

  public companion object {
    public const val MINIMUM_PERIODIC_INTERVAL_MINUTES: Int = 15
  }
}
