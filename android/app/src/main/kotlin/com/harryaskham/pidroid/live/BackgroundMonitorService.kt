package com.harryaskham.pidroid.live

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import com.harryaskham.pidroid.MainActivity
import com.harryaskham.pidroid.integration.ContentSafeNotification
import com.harryaskham.pidroid.integration.ContentSafeNotificationProjector
import com.harryaskham.pidroid.integration.ForegroundMonitorMachine
import com.harryaskham.pidroid.integration.ForegroundServiceAdapter
import com.harryaskham.pidroid.integration.ForegroundServiceDirective
import com.harryaskham.pidroid.integration.ForegroundServicePlan
import com.harryaskham.pidroid.integration.MonitorPhase
import com.harryaskham.pidroid.integration.MonitorStopReason
import com.harryaskham.pidroid.integration.MonitoredSession
import com.harryaskham.pidroid.integration.NotificationChannel
import com.harryaskham.pidroid.integration.SessionNotificationSignalMapper
import com.harryaskham.pidroid.sdk.core.ApiResult
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.PiDaemonClient
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.ServiceBearerRequestFactory
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import android.app.NotificationChannel as AndroidNotificationChannel

/** Content-free identity accepted only from the non-exported in-app service boundary. */
public data class BackgroundMonitorIdentity(
  public val hostId: HostId,
  public val hostInstanceId: String,
  public val bearerGeneration: Int,
  public val sessionId: String,
  public val generation: Int,
) {
  public fun monitoredSession(): MonitoredSession = MonitoredSession(hostId, hostInstanceId, bearerGeneration, sessionId, generation)
}

public object BackgroundMonitorControl {
  @Volatile
  private var enabled: Boolean = false

  public fun isEnabled(context: Context): Boolean = enabled

  public fun start(
    context: Context,
    identity: BackgroundMonitorIdentity,
  ) {
    setEnabled(context, true)
    val intent =
      Intent(context, BackgroundMonitorService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_HOST_ID, identity.hostId.value)
        .putExtra(EXTRA_HOST_INSTANCE_ID, identity.hostInstanceId)
        .putExtra(EXTRA_BEARER_GENERATION, identity.bearerGeneration)
        .putExtra(EXTRA_SESSION_ID, identity.sessionId)
        .putExtra(EXTRA_SESSION_GENERATION, identity.generation)
    context.startForegroundService(intent)
  }

  public fun stop(context: Context) {
    setEnabled(context, false)
    context.startService(Intent(context, BackgroundMonitorService::class.java).setAction(ACTION_STOP))
  }

  internal fun setEnabled(
    context: Context,
    enabled: Boolean,
  ) {
    this.enabled = enabled
  }

  internal const val ACTION_START: String = "com.harryaskham.pidroid.action.START_MONITOR"
  internal const val ACTION_STOP: String = "com.harryaskham.pidroid.action.STOP_MONITOR"
  internal const val EXTRA_HOST_ID: String = "host-id"
  internal const val EXTRA_HOST_INSTANCE_ID: String = "host-instance-id"
  internal const val EXTRA_BEARER_GENERATION: String = "bearer-generation"
  internal const val EXTRA_SESSION_ID: String = "session-id"
  internal const val EXTRA_SESSION_GENERATION: String = "session-generation"
}

/**
 * Explicitly user-started, bounded metadata monitor.
 *
 * It requests only capabilities and retained-session metadata. It never opens an RPC/TUI socket,
 * fetches a transcript, or sends prompt/tool content. Failures are represented only by fixed local
 * copy and bounded backoff; exception text is never logged or placed in a notification.
 */
public class BackgroundMonitorService : Service() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val transport = OkHttpPiDaemonTransport()
  private val monitorMachine = ForegroundMonitorMachine(maxSessions = 1)
  private lateinit var monitorAdapter: ForegroundServiceAdapter
  private var pollJob: Job? = null
  private var lastState: String? = null
  private var eventSequence: Long = 0

  override fun onCreate() {
    super.onCreate()
    createChannels()
    monitorAdapter = ForegroundServiceAdapter(monitorMachine, ::applyServicePlan)
  }

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    when (intent?.action) {
      BackgroundMonitorControl.ACTION_START -> startMonitoring(intent)
      BackgroundMonitorControl.ACTION_STOP -> stopMonitoring(MonitorStopReason.USER_STOP)
      else -> stopMonitoring(MonitorStopReason.USER_STOP)
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(
    startId: Int,
    fgsType: Int,
  ) {
    stopMonitoring(MonitorStopReason.SIX_HOUR_TIMEOUT)
  }

  override fun onDestroy() {
    pollJob?.cancel()
    transport.close()
    scope.cancel()
    BackgroundMonitorControl.setEnabled(this, false)
    super.onDestroy()
  }

  private fun startMonitoring(intent: Intent) {
    val identity =
      decodeIdentity(intent) ?: run {
        BackgroundMonitorControl.setEnabled(this, false)
        stopSelf()
        return
      }
    val granted = notificationsGranted()
    val snapshot =
      monitorAdapter.start(
        session = identity.monitoredSession(),
        nowMillis = SystemClock.elapsedRealtime(),
        userInitiated = true,
        notificationsGranted = granted,
      )
    if (!granted || snapshot.phase == MonitorPhase.PERMISSION_DENIED || snapshot.sessions.isEmpty()) {
      BackgroundMonitorControl.setEnabled(this, false)
      stopSelf()
      return
    }
    BackgroundMonitorControl.setEnabled(this, true)
    if (pollJob?.isActive != true) pollJob = scope.launch { poll(identity.monitoredSession()) }
  }

  private fun stopMonitoring(reason: MonitorStopReason) {
    if (monitorMachine.snapshot.sessions.isNotEmpty()) {
      monitorAdapter.stop(reason, SystemClock.elapsedRealtime())
    } else {
      BackgroundMonitorControl.setEnabled(this, false)
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private suspend fun poll(session: MonitoredSession) {
    var delayMillis = INITIAL_POLL_MILLIS
    while (scope.isActive) {
      val now = SystemClock.elapsedRealtime()
      if (!notificationsGranted()) {
        monitorAdapter.onNotificationPermission(false, now)
        break
      }
      val power = getSystemService(PowerManager::class.java)
      val dozing = power?.isDeviceIdleMode == true
      val dozeSnapshot = monitorAdapter.onDoze(dozing, now)
      if (dozeSnapshot.sessions.isEmpty()) break
      if (dozing) {
        delay(DOZE_POLL_MILLIS)
        continue
      }

      when (val result = pollMetadata(session)) {
        is MetadataPollResult.Current -> {
          monitorAdapter.onNetworkAvailable(true, SystemClock.elapsedRealtime())
          publishStateChange(session, result.state)
          delayMillis = HEALTHY_POLL_MILLIS
        }

        MetadataPollResult.TransientFailure -> {
          monitorAdapter.onNetworkAvailable(false, SystemClock.elapsedRealtime())
          delayMillis = (delayMillis * 2).coerceAtMost(MAX_BACKOFF_MILLIS)
        }

        MetadataPollResult.AuthorityLost -> {
          monitorAdapter.stop(MonitorStopReason.AUTHORITY_LOST, SystemClock.elapsedRealtime())
          break
        }
      }
      val tick = monitorAdapter.tick(SystemClock.elapsedRealtime())
      if (tick.sessions.isEmpty()) break
      val deadline = requireNotNull(tick.startedAtMillis) + MAX_MONITOR_MILLIS
      val remaining = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0)
      delay(delayMillis.coerceAtMost(remaining))
    }
  }

  private suspend fun pollMetadata(session: MonitoredSession): MetadataPollResult =
    try {
      val hosts = AndroidHostRegistry(this)
      val registered =
        hosts.registry.list().firstOrNull { it.id == session.hostId }
          ?: return MetadataPollResult.AuthorityLost
      if (registered.credential.bearerGeneration != session.bearerGeneration) {
        return MetadataPollResult.AuthorityLost
      }
      hosts.credentialVault.withBearerSuspending(registered.credential) { bearer ->
        val descriptor = PiDaemonHostDescriptor(registered.id, registered.displayName, registered.baseUri)
        ServiceBearerRequestFactory
          .create(
            host = descriptor,
            bearer = bearer,
            allowInsecureHttp = registered.transportSecurity != TransportSecurity.HTTPS,
          ).use { factory ->
            val client = PiDaemonClient(descriptor, factory, transport)
            val capabilitiesResult = client.capabilities()
            when (capabilitiesResult) {
              is ApiResult.Success -> Unit
              is ApiResult.Failure -> return@use MetadataPollResult.TransientFailure
            }
            if (capabilitiesResult.hostInstanceId != session.hostInstanceId) {
              return@use MetadataPollResult.AuthorityLost
            }
            var cursor: String? = null
            repeat(MAX_SESSION_PAGES) {
              val page =
                when (val result = client.listSessions(limit = 100, cursor = cursor)) {
                  is ApiResult.Success -> result.value
                  is ApiResult.Failure -> return@use MetadataPollResult.TransientFailure
                }
              page.sessions
                .firstOrNull {
                  it.key.sessionId == session.sessionId && it.key.generation == session.generation
                }?.let { return@use MetadataPollResult.Current(it.state) }
              cursor = page.nextCursor ?: return@use MetadataPollResult.AuthorityLost
            }
            MetadataPollResult.TransientFailure
          }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Throwable) {
      MetadataPollResult.TransientFailure
    }

  private fun publishStateChange(
    session: MonitoredSession,
    state: String,
  ) {
    val previous = lastState
    lastState = state
    if (previous == state) return
    val eventId = "poll-${eventSequence++}"
    val signal =
      if (state == "running" || state == "streaming") {
        SessionNotificationSignalMapper.running(session, eventId)
      } else if (previous == "running" || previous == "streaming") {
        SessionNotificationSignalMapper.terminal(session, eventId, succeeded = state !in setOf("failed", "absent"))
      } else {
        return
      }
    post(ContentSafeNotificationProjector.project(signal))
  }

  private fun applyServicePlan(plan: ForegroundServicePlan) {
    when (plan.directive) {
      ForegroundServiceDirective.START -> {
        val notification = buildNotification(plan.notification)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          startForeground(FOREGROUND_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
          startForeground(FOREGROUND_NOTIFICATION_ID, notification)
        }
      }

      ForegroundServiceDirective.UPDATE -> {
        getSystemService(NotificationManager::class.java).notify(FOREGROUND_NOTIFICATION_ID, buildNotification(plan.notification))
      }

      ForegroundServiceDirective.STOP -> {
        BackgroundMonitorControl.setEnabled(this, false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
  }

  private fun post(notification: ContentSafeNotification) {
    if (!notificationsGranted()) return
    val notificationId = EVENT_NOTIFICATION_ID_BASE + ((notification.id.eventId.hashCode() and Int.MAX_VALUE) % 10_000)
    getSystemService(NotificationManager::class.java).notify(notificationId, buildNotification(notification))
  }

  private fun buildNotification(content: ContentSafeNotification): Notification {
    val open =
      PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    return Notification
      .Builder(this, content.channel.wireName)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(content.title)
      .setContentText(content.body)
      .setContentIntent(open)
      .setOngoing(content.ongoing)
      .setOnlyAlertOnce(content.ongoing)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  private fun createChannels() {
    val manager = getSystemService(NotificationManager::class.java)
    NotificationChannel.entries.forEach { channel ->
      val importance =
        if (channel == NotificationChannel.HOST_STATE) NotificationManager.IMPORTANCE_LOW else NotificationManager.IMPORTANCE_DEFAULT
      manager.createNotificationChannel(
        AndroidNotificationChannel(channel.wireName, channelLabel(channel), importance).apply {
          description = "Content-safe Pi Droid ${channelLabel(channel).lowercase()} notifications"
        },
      )
    }
  }

  private fun notificationsGranted(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  private fun decodeIdentity(intent: Intent): BackgroundMonitorIdentity? =
    runCatching {
      BackgroundMonitorIdentity(
        hostId = HostId(requireNotNull(intent.getStringExtra(BackgroundMonitorControl.EXTRA_HOST_ID))),
        hostInstanceId = requireNotNull(intent.getStringExtra(BackgroundMonitorControl.EXTRA_HOST_INSTANCE_ID)),
        bearerGeneration = intent.getIntExtra(BackgroundMonitorControl.EXTRA_BEARER_GENERATION, -1),
        sessionId = requireNotNull(intent.getStringExtra(BackgroundMonitorControl.EXTRA_SESSION_ID)),
        generation = intent.getIntExtra(BackgroundMonitorControl.EXTRA_SESSION_GENERATION, -1),
      ).also { it.monitoredSession() }
    }.getOrNull()

  private fun channelLabel(channel: NotificationChannel): String =
    when (channel) {
      NotificationChannel.ACTIVITY -> "Session activity"
      NotificationChannel.TERMINAL -> "Session completion"
      NotificationChannel.INPUT_REQUIRED -> "Input required"
      NotificationChannel.HOST_STATE -> "Host and monitoring state"
    }

  private companion object {
    const val FOREGROUND_NOTIFICATION_ID: Int = 41_001
    const val MAX_SESSION_PAGES: Int = 4
    const val EVENT_NOTIFICATION_ID_BASE: Int = 42_000
    const val MAX_MONITOR_MILLIS: Long = 6 * 60 * 60 * 1_000
    const val INITIAL_POLL_MILLIS: Long = 15_000
    const val HEALTHY_POLL_MILLIS: Long = 60_000
    const val MAX_BACKOFF_MILLIS: Long = 5 * 60_000
    const val DOZE_POLL_MILLIS: Long = 5 * 60_000
  }
}

private sealed interface MetadataPollResult {
  data class Current(
    val state: String,
  ) : MetadataPollResult

  data object TransientFailure : MetadataPollResult

  data object AuthorityLost : MetadataPollResult
}
