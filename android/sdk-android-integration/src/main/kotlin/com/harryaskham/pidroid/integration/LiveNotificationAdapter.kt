package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.SessionRpcFrame
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

public enum class SessionNotificationState {
  WAKING,
  RUNNING,
  TERMINAL_SUCCEEDED,
  TERMINAL_FAILED,
  INPUT_REQUIRED,
  HOST_DISCONNECTED,
  HOST_RECOVERED,
  RESYNCING,
  BACKGROUND_UPDATE,
}

public data class SessionNotificationSignal(
  public val id: NotificationEventId,
  public val state: SessionNotificationState,
)

/**
 * Maps bounded SDK event envelopes into notification states without retaining event content.
 *
 * Wake admission, disconnect, input-required, and terminal failures are local lifecycle facts and
 * therefore enter through explicit methods. Streaming frames contribute only their validated
 * identity/cursor and event type; model text, tool output, and extension payloads are ignored.
 */
public object SessionNotificationSignalMapper {
  public fun fromFrame(
    session: MonitoredSession,
    frame: SessionRpcFrame,
  ): SessionNotificationSignal? =
    when (frame) {
      is SessionRpcFrame.AttachReady -> {
        require(
          frame.hostInstanceId == session.hostInstanceId &&
            frame.sessionId == session.sessionId &&
            frame.generation == session.generation,
        ) { "attach-ready notification identity does not match the monitored session" }
        signal(session, "attach:${frame.highWaterCursor}", SessionNotificationState.HOST_RECOVERED)
      }

      is SessionRpcFrame.ReplayGap -> {
        signal(session, "gap:${frame.highWaterCursor}", SessionNotificationState.RESYNCING)
      }

      is SessionRpcFrame.Event -> {
        fromEvent(session, frame)
      }

      else -> {
        null
      }
    }

  public fun wakeQueued(
    session: MonitoredSession,
    requestId: String,
  ): SessionNotificationSignal = signal(session, requestId, SessionNotificationState.WAKING)

  public fun running(
    session: MonitoredSession,
    eventId: String,
  ): SessionNotificationSignal = signal(session, eventId, SessionNotificationState.RUNNING)

  public fun inputRequired(
    session: MonitoredSession,
    eventId: String,
  ): SessionNotificationSignal = signal(session, eventId, SessionNotificationState.INPUT_REQUIRED)

  public fun terminal(
    session: MonitoredSession,
    eventId: String,
    succeeded: Boolean,
  ): SessionNotificationSignal =
    signal(
      session,
      eventId,
      if (succeeded) SessionNotificationState.TERMINAL_SUCCEEDED else SessionNotificationState.TERMINAL_FAILED,
    )

  public fun hostDisconnected(
    session: MonitoredSession,
    eventId: String,
  ): SessionNotificationSignal = signal(session, eventId, SessionNotificationState.HOST_DISCONNECTED)

  private fun fromEvent(
    session: MonitoredSession,
    frame: SessionRpcFrame.Event,
  ): SessionNotificationSignal? {
    val event = frame.raw["event"] as? JsonObject ?: return null
    val type = (event["type"] as? JsonPrimitive)?.content ?: return null
    val state =
      when (type) {
        "agent_start" -> SessionNotificationState.RUNNING
        "agent_settled" -> SessionNotificationState.TERMINAL_SUCCEEDED
        else -> return null
      }
    return signal(session, frame.cursor, state)
  }

  private fun signal(
    session: MonitoredSession,
    eventId: String,
    state: SessionNotificationState,
  ): SessionNotificationSignal = SessionNotificationSignal(NotificationEventId(session, eventId), state)
}

public class ContentSafeNotification(
  public val id: NotificationEventId,
  public val channel: NotificationChannel,
  public val state: SessionNotificationState,
  public val title: String,
  public val body: String,
  public val ongoing: Boolean = false,
) {
  init {
    require(channel.contentSafe) { "notification channel must be content safe" }
    require(title in SAFE_TITLES && body in SAFE_BODIES) {
      "notification copy must come from the fixed content-safe vocabulary"
    }
  }

  override fun toString(): String =
    "ContentSafeNotification(channel=${channel.wireName}, state=$state, ongoing=$ongoing, identity=[REDACTED], content=[REDACTED])"

  private companion object {
    val SAFE_TITLES: Set<String> =
      setOf(
        "Session waking",
        "Session running",
        "Session completed",
        "Session failed",
        "Session needs input",
        "Host unavailable",
        "Host connected",
        "Session resynchronizing",
        "Session update",
        "Monitoring active",
        "Monitoring paused",
        "Monitoring stopped",
      )
    val SAFE_BODIES: Set<String> =
      setOf(
        "A monitored session is starting.",
        "A monitored session is active.",
        "A monitored session finished.",
        "A monitored session did not finish successfully.",
        "A monitored session is waiting for input.",
        "A monitored host cannot be reached.",
        "A monitored host is reachable again.",
        "A monitored session is refreshing its state.",
        "A monitored session has a new status.",
        "User-started background monitoring is active.",
        "Background monitoring is temporarily paused.",
        "Background monitoring has stopped.",
      )
  }
}

public object ContentSafeNotificationProjector {
  public fun project(signal: SessionNotificationSignal): ContentSafeNotification {
    val (channel, copy) =
      when (signal.state) {
        SessionNotificationState.WAKING -> {
          NotificationChannel.ACTIVITY to ("Session waking" to "A monitored session is starting.")
        }

        SessionNotificationState.RUNNING -> {
          NotificationChannel.ACTIVITY to ("Session running" to "A monitored session is active.")
        }

        SessionNotificationState.TERMINAL_SUCCEEDED -> {
          NotificationChannel.TERMINAL to
            ("Session completed" to "A monitored session finished.")
        }

        SessionNotificationState.TERMINAL_FAILED -> {
          NotificationChannel.TERMINAL to
            ("Session failed" to "A monitored session did not finish successfully.")
        }

        SessionNotificationState.INPUT_REQUIRED -> {
          NotificationChannel.INPUT_REQUIRED to
            ("Session needs input" to "A monitored session is waiting for input.")
        }

        SessionNotificationState.HOST_DISCONNECTED -> {
          NotificationChannel.HOST_STATE to
            ("Host unavailable" to "A monitored host cannot be reached.")
        }

        SessionNotificationState.HOST_RECOVERED -> {
          NotificationChannel.HOST_STATE to
            ("Host connected" to "A monitored host is reachable again.")
        }

        SessionNotificationState.RESYNCING -> {
          NotificationChannel.HOST_STATE to
            ("Session resynchronizing" to "A monitored session is refreshing its state.")
        }

        SessionNotificationState.BACKGROUND_UPDATE -> {
          NotificationChannel.ACTIVITY to
            ("Session update" to "A monitored session has a new status.")
        }
      }
    return ContentSafeNotification(signal.id, channel, signal.state, copy.first, copy.second)
  }

  public fun project(candidate: CatchUpCandidate): ContentSafeNotification =
    ContentSafeNotification(
      id = candidate.id,
      channel = candidate.channel,
      state = SessionNotificationState.BACKGROUND_UPDATE,
      title = "Session update",
      body = "A monitored session has a new status.",
    )
}

/** Policy and dedupe are applied before any record reaches an Android notification sink. */
public class SessionNotificationAdapter(
  private val dedupe: NotificationDedupeLedger,
  private val policy: NotificationPolicy,
) {
  public fun emit(
    signal: SessionNotificationSignal,
    minuteOfDay: Int,
  ): ContentSafeNotification? {
    if (policy.suppression(signal.id.session, minuteOfDay) != null) return null
    if (!dedupe.admit(signal.id)) return null
    return ContentSafeNotificationProjector.project(signal)
  }
}

public enum class NotificationAction {
  OPEN,
  ABORT,
  FOLLOW_UP,
}

public data class NotificationAuthority(
  public val session: MonitoredSession,
  public val role: InteractiveControllerRole,
  public val freshness: CacheFreshness,
)

/** Returns intents only. The embedding app must revalidate authority before executing an intent. */
public object NotificationActionPolicy {
  public fun actions(
    notification: ContentSafeNotification,
    authority: NotificationAuthority?,
  ): Set<NotificationAction> {
    if (
      authority == null ||
      authority.session != notification.id.session ||
      authority.role != InteractiveControllerRole.CONTROLLER ||
      authority.freshness != CacheFreshness.FRESH
    ) {
      return setOf(NotificationAction.OPEN)
    }
    return when (notification.state) {
      SessionNotificationState.WAKING,
      SessionNotificationState.RUNNING,
      -> setOf(NotificationAction.OPEN, NotificationAction.ABORT)

      SessionNotificationState.TERMINAL_SUCCEEDED,
      SessionNotificationState.TERMINAL_FAILED,
      SessionNotificationState.INPUT_REQUIRED,
      -> setOf(NotificationAction.OPEN, NotificationAction.FOLLOW_UP)

      else -> setOf(NotificationAction.OPEN)
    }
  }
}

public enum class ForegroundServiceDirective {
  START,
  UPDATE,
  STOP,
}

public data class ForegroundServicePlan(
  public val directive: ForegroundServiceDirective,
  public val serviceType: ForegroundServiceType,
  public val notification: ContentSafeNotification,
  public val stopReason: MonitorStopReason? = null,
)

public fun interface ForegroundServiceDriver {
  public fun apply(plan: ForegroundServicePlan)
}

/**
 * Thin Android-lifecycle port over [ForegroundMonitorMachine]. It emits dataSync service plans but
 * owns no Context, Service, socket, or process lifetime.
 */
public class ForegroundServiceAdapter(
  private val machine: ForegroundMonitorMachine,
  private val driver: ForegroundServiceDriver,
) {
  public fun start(
    session: MonitoredSession,
    nowMillis: Long,
    userInitiated: Boolean,
    notificationsGranted: Boolean,
  ): ForegroundMonitorSnapshot = transition { machine.start(session, nowMillis, userInitiated, notificationsGranted) }

  public fun onDoze(
    enabled: Boolean,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot = transition { machine.onDoze(enabled, nowMillis) }

  public fun onNetworkAvailable(
    available: Boolean,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot = transition { machine.onNetworkAvailable(available, nowMillis) }

  public fun onNotificationPermission(
    granted: Boolean,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot = transition { machine.onNotificationPermission(granted, nowMillis) }

  public fun tick(nowMillis: Long): ForegroundMonitorSnapshot = transition { machine.tick(nowMillis) }

  public fun stop(
    reason: MonitorStopReason,
    nowMillis: Long,
  ): ForegroundMonitorSnapshot = transition { machine.stop(reason, nowMillis) }

  private fun transition(reduce: () -> ForegroundMonitorSnapshot): ForegroundMonitorSnapshot {
    val previous = machine.snapshot
    val next = reduce()
    plan(previous, next)?.let(driver::apply)
    return next
  }

  private fun plan(
    previous: ForegroundMonitorSnapshot,
    next: ForegroundMonitorSnapshot,
  ): ForegroundServicePlan? {
    val wasActive = previous.sessions.isNotEmpty()
    val isActive = next.sessions.isNotEmpty()
    val directive =
      when {
        !wasActive && isActive -> ForegroundServiceDirective.START
        wasActive && isActive && previous.hasVisibleChange(next) -> ForegroundServiceDirective.UPDATE
        wasActive && !isActive -> ForegroundServiceDirective.STOP
        else -> return null
      }
    val copy =
      when {
        directive == ForegroundServiceDirective.STOP -> {
          "Monitoring stopped" to "Background monitoring has stopped."
        }

        next.phase == MonitorPhase.RUNNING -> {
          "Monitoring active" to "User-started background monitoring is active."
        }

        else -> {
          "Monitoring paused" to "Background monitoring is temporarily paused."
        }
      }
    val identity =
      next.sessions.firstOrNull()?.identity ?: previous.sessions.first().identity
    return ForegroundServicePlan(
      directive = directive,
      serviceType = ForegroundServiceType.DATA_SYNC,
      notification =
        ContentSafeNotification(
          id = NotificationEventId(identity, "monitor:${next.updatedAtMillis}:$directive"),
          channel = NotificationChannel.HOST_STATE,
          state = SessionNotificationState.BACKGROUND_UPDATE,
          title = copy.first,
          body = copy.second,
          ongoing = directive != ForegroundServiceDirective.STOP,
        ),
      stopReason = next.stopReason,
    )
  }

  private fun ForegroundMonitorSnapshot.hasVisibleChange(next: ForegroundMonitorSnapshot): Boolean =
    phase != next.phase || sessions != next.sessions || failure != next.failure || stopReason != next.stopReason
}

public fun interface NotificationSink {
  public fun notify(notification: ContentSafeNotification)
}

/** Pure WorkManager entry adapter. Android scheduling and retries remain owned by the embedding app. */
public class WorkManagerCatchUpAdapter(
  private val worker: CatchUpWorker,
  private val sink: NotificationSink,
) {
  public fun run(
    constraints: CatchUpConstraints,
    nowMillis: Long,
    minuteOfDay: Int,
  ): CatchUpResult {
    val result = worker.run(constraints, nowMillis, minuteOfDay)
    result.notifications
      .map(ContentSafeNotificationProjector::project)
      .forEach(sink::notify)
    return result
  }
}
