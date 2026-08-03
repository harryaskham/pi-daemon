package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.HostId

public enum class NotificationChannel(
  public val wireName: String,
  public val contentSafe: Boolean = true,
) {
  ACTIVITY("activity"),
  TERMINAL("terminal"),
  INPUT_REQUIRED("input-required"),
  HOST_STATE("host-state"),
}

public data class MonitoredSession(
  public val hostId: HostId,
  public val hostInstanceId: String,
  public val bearerGeneration: Int,
  public val sessionId: String,
  public val generation: Int,
) {
  init {
    require(hostInstanceId.isBoundedIdentifier()) { "host instance ID is invalid" }
    require(bearerGeneration >= 0) { "bearer generation must be non-negative" }
    require(sessionId.isBoundedIdentifier()) { "session ID is invalid" }
    require(generation >= 0) { "session generation must be non-negative" }
  }
}

public data class SessionMuteKey(
  public val hostId: HostId,
  public val sessionId: String,
) {
  init {
    require(sessionId.isBoundedIdentifier()) { "muted session ID is invalid" }
  }
}

public data class NotificationEventId(
  public val session: MonitoredSession,
  public val eventId: String,
) {
  init {
    require(eventId.isBoundedIdentifier()) { "notification event ID is invalid" }
  }
}

public data class QuietHours(
  public val startMinute: Int,
  public val endMinute: Int,
) {
  init {
    require(startMinute in 0 until MINUTES_PER_DAY) { "quiet-hours start is invalid" }
    require(endMinute in 0 until MINUTES_PER_DAY) { "quiet-hours end is invalid" }
    require(startMinute != endMinute) { "quiet hours cannot cover an ambiguous full day" }
  }

  public fun contains(minuteOfDay: Int): Boolean {
    require(minuteOfDay in 0 until MINUTES_PER_DAY) { "minute of day is invalid" }
    return if (startMinute < endMinute) {
      minuteOfDay in startMinute until endMinute
    } else {
      minuteOfDay >= startMinute || minuteOfDay < endMinute
    }
  }

  public companion object {
    public const val MINUTES_PER_DAY: Int = 24 * 60
  }
}

public enum class NotificationSuppression {
  HOST_MUTED,
  SESSION_MUTED,
  QUIET_HOURS,
}

public data class NotificationPolicy(
  public val mutedHosts: Set<HostId> = emptySet(),
  public val mutedSessions: Set<SessionMuteKey> = emptySet(),
  public val quietHours: QuietHours? = null,
) {
  public fun suppression(
    session: MonitoredSession,
    minuteOfDay: Int,
  ): NotificationSuppression? =
    when {
      session.hostId in mutedHosts -> NotificationSuppression.HOST_MUTED
      SessionMuteKey(session.hostId, session.sessionId) in mutedSessions -> NotificationSuppression.SESSION_MUTED
      quietHours?.contains(minuteOfDay) == true -> NotificationSuppression.QUIET_HOURS
      else -> null
    }
}

/** Bounded insertion-ordered dedupe. Values contain identity only, never content. */
public class NotificationDedupeLedger(
  public val maxEntries: Int,
) {
  private val entries = linkedSetOf<NotificationEventId>()

  init {
    require(maxEntries in 1..65_536) { "notification dedupe capacity is invalid" }
  }

  public val size: Int
    @Synchronized get() = entries.size

  @Synchronized
  public fun admit(id: NotificationEventId): Boolean {
    if (!entries.add(id)) return false
    while (entries.size > maxEntries) entries.remove(entries.first())
    return true
  }

  @Synchronized
  public fun purgeHost(hostId: HostId) {
    entries.removeAll { it.session.hostId == hostId }
  }
}

internal fun String.isBoundedIdentifier(): Boolean = matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"))
