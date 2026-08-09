package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.CacheFreshness

public enum class ForegroundServiceType(
  public val manifestValue: String,
) {
  DATA_SYNC("dataSync"),
}

public enum class MonitorPhase {
  IDLE,
  RUNNING,
  RECONNECTING,
  PAUSED_DOZE,
  PERMISSION_DENIED,
  TIMED_OUT,
}

public enum class MonitorFailure {
  USER_ACTION_REQUIRED,
  NOTIFICATION_PERMISSION_DENIED,
  SESSION_LIMIT,
}

public enum class MonitorStopReason {
  USER_STOP,
  PERMISSION_REVOKED,
  AUTHORITY_LOST,
  SIX_HOUR_TIMEOUT,
}

public data class MonitoredSessionState(
  public val identity: MonitoredSession,
  public val freshness: CacheFreshness,
)

public data class ForegroundMonitorSnapshot(
  public val serviceType: ForegroundServiceType,
  public val phase: MonitorPhase,
  public val sessions: List<MonitoredSessionState>,
  public val startedAtMillis: Long?,
  public val updatedAtMillis: Long,
  public val failure: MonitorFailure? = null,
  public val stopReason: MonitorStopReason? = null,
)

/**
 * Pure reference reducer for a future Android dataSync foreground service.
 *
 * It opens no socket and schedules no process work. Android lifecycle adapters translate explicit
 * user/permission/network/Doze events into these transitions.
 */
public class ForegroundMonitorMachine(
  public val maxSessions: Int = 8,
  public val maxDurationMillis: Long = 6 * 60 * 60 * 1_000L,
) {
  private val sessions = linkedMapOf<MonitoredSession, MonitoredSessionState>()
  private var startedAtMillis: Long? = null
  private var phase: MonitorPhase = MonitorPhase.IDLE
  private var updatedAtMillis: Long = 0
  private var stopReason: MonitorStopReason? = null
  private var dozeEnabled: Boolean = false
  private var networkAvailable: Boolean = true

  init {
    require(maxSessions in 1..8) { "foreground monitored-session limit must be between 1 and 8" }
    require(maxDurationMillis in 1..MAX_DURATION_MILLIS) { "foreground monitor duration is invalid" }
  }

  public val snapshot: ForegroundMonitorSnapshot
    @Synchronized get() = current()

  @Synchronized
  public fun start(
    session: MonitoredSession,
    nowMillis: Long,
    userInitiated: Boolean,
    notificationsGranted: Boolean,
  ): ForegroundMonitorSnapshot {
    requireNow(nowMillis)
    if (!userInitiated) return current(MonitorFailure.USER_ACTION_REQUIRED)
    if (!notificationsGranted) {
      stopInternal(MonitorPhase.PERMISSION_DENIED, nowMillis, MonitorStopReason.PERMISSION_REVOKED)
      return current(MonitorFailure.NOTIFICATION_PERMISSION_DENIED)
    }
    if (session !in sessions && sessions.size >= maxSessions) return current(MonitorFailure.SESSION_LIMIT)
    if (sessions.isEmpty()) startedAtMillis = nowMillis
    sessions[session] = MonitoredSessionState(session, effectiveFreshness())
    phase = effectiveActivePhase()
    updatedAtMillis = nowMillis
    stopReason = null
    return current()
  }

  @Synchronized
  public fun onDoze(
    enabled: Boolean,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot {
    requireNow(nowMillis)
    dozeEnabled = enabled
    if (sessions.isEmpty()) return current()
    replaceFreshness(effectiveFreshness())
    phase = effectiveActivePhase()
    updatedAtMillis = nowMillis
    return current()
  }

  @Synchronized
  public fun onNetworkAvailable(
    available: Boolean,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot {
    requireNow(nowMillis)
    networkAvailable = available
    if (sessions.isEmpty()) return current()
    replaceFreshness(effectiveFreshness())
    phase = effectiveActivePhase()
    updatedAtMillis = nowMillis
    return current()
  }

  @Synchronized
  public fun onNotificationPermission(
    granted: Boolean,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot {
    requireNow(nowMillis)
    if (!granted) stopInternal(MonitorPhase.PERMISSION_DENIED, nowMillis, MonitorStopReason.PERMISSION_REVOKED)
    return current()
  }

  @Synchronized
  public fun tick(nowMillis: Long): ForegroundMonitorSnapshot {
    requireNow(nowMillis)
    val started = startedAtMillis
    if (started != null && nowMillis - started >= maxDurationMillis) {
      stopInternal(MonitorPhase.TIMED_OUT, nowMillis, MonitorStopReason.SIX_HOUR_TIMEOUT)
    } else {
      updatedAtMillis = nowMillis
    }
    return current()
  }

  @Synchronized
  public fun stop(
    reason: MonitorStopReason,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot {
    requireNow(nowMillis)
    stopInternal(MonitorPhase.IDLE, nowMillis, reason)
    return current()
  }

  private fun replaceFreshness(freshness: CacheFreshness) {
    sessions.replaceAll { _, value -> value.copy(freshness = freshness) }
  }

  private fun effectiveFreshness(): CacheFreshness =
    when {
      dozeEnabled -> CacheFreshness.STALE
      !networkAvailable -> CacheFreshness.RECONNECTING
      else -> CacheFreshness.FRESH
    }

  private fun effectiveActivePhase(): MonitorPhase =
    when {
      dozeEnabled -> MonitorPhase.PAUSED_DOZE
      !networkAvailable -> MonitorPhase.RECONNECTING
      else -> MonitorPhase.RUNNING
    }

  private fun stopInternal(
    nextPhase: MonitorPhase,
    nowMillis: Long,
    reason: MonitorStopReason,
  ) {
    sessions.clear()
    startedAtMillis = null
    phase = nextPhase
    updatedAtMillis = nowMillis
    stopReason = reason
  }

  private fun current(failure: MonitorFailure? = null): ForegroundMonitorSnapshot =
    ForegroundMonitorSnapshot(
      serviceType = ForegroundServiceType.DATA_SYNC,
      phase = phase,
      sessions = sessions.values.toList(),
      startedAtMillis = startedAtMillis,
      updatedAtMillis = updatedAtMillis,
      failure = failure,
      stopReason = stopReason,
    )

  private fun requireNow(nowMillis: Long) {
    require(nowMillis >= updatedAtMillis) { "monitor clock must be monotonic" }
  }

  private companion object {
    const val MAX_DURATION_MILLIS: Long = 6 * 60 * 60 * 1_000L
  }
}
