package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NotificationAndBackgroundContractTest {
  private val session = MonitoredSession(HostId("workstation"), "host-instance-01", 1, "session-01", 3)

  @Test
  fun `channel taxonomy is content safe and mute quiet policy is exact`() {
    assertEquals(
      setOf("activity", "terminal", "input-required", "host-state"),
      NotificationChannel.entries.mapTo(sortedSetOf(), NotificationChannel::wireName),
    )
    assertTrue(NotificationChannel.entries.all(NotificationChannel::contentSafe))

    val quiet = QuietHours(startMinute = 22 * 60, endMinute = 7 * 60)
    val policy =
      NotificationPolicy(
        mutedHosts = setOf(HostId("muted-host")),
        mutedSessions = setOf(SessionMuteKey(session.hostId, "session-muted")),
        quietHours = quiet,
      )
    assertTrue(quiet.contains(23 * 60))
    assertTrue(quiet.contains(6 * 60 + 59))
    assertFalse(quiet.contains(12 * 60))
    assertEquals(NotificationSuppression.QUIET_HOURS, policy.suppression(session, 23 * 60))
    assertEquals(NotificationSuppression.HOST_MUTED, policy.suppression(session.copy(hostId = HostId("muted-host")), 12 * 60))
    assertEquals(
      NotificationSuppression.SESSION_MUTED,
      policy.suppression(
        session.copy(sessionId = "session-muted", hostInstanceId = "host-restarted", generation = 99),
        12 * 60,
      ),
    )
    assertEquals(null, policy.suppression(session, 12 * 60))
  }

  @Test
  fun `dedupe identity includes host bearer incarnation session generation and event`() {
    val ledger = NotificationDedupeLedger(maxEntries = 3)
    val first = NotificationEventId(session, "event-01")
    assertTrue(ledger.admit(first))
    assertFalse(ledger.admit(first))
    assertTrue(ledger.admit(first.copy(session = session.copy(generation = 4))))
    assertTrue(ledger.admit(first.copy(session = session.copy(bearerGeneration = 2))))
    assertTrue(ledger.admit(first.copy(session = session.copy(hostInstanceId = "host-instance-02"))))
    assertEquals(3, ledger.size)
    assertTrue(ledger.admit(first), "oldest identity is evicted only after exact capacity")
  }

  @Test
  fun `foreground monitoring is user started bounded and stops on denial doze timeout and Stop`() {
    val machine = ForegroundMonitorMachine(maxSessions = 8, maxDurationMillis = 6 * 60 * 60 * 1_000L)
    assertEquals(ForegroundServiceType.DATA_SYNC, machine.snapshot.serviceType)
    assertEquals(MonitorPhase.IDLE, machine.snapshot.phase)
    assertEquals(MonitorFailure.USER_ACTION_REQUIRED, machine.start(session, 0, userInitiated = false, notificationsGranted = true).failure)
    assertEquals(
      MonitorFailure.NOTIFICATION_PERMISSION_DENIED,
      machine.start(session, 0, userInitiated = true, notificationsGranted = false).failure,
    )

    assertEquals(MonitorPhase.RUNNING, machine.start(session, 1_000, userInitiated = true, notificationsGranted = true).phase)
    repeat(7) { index ->
      assertEquals(
        MonitorPhase.RUNNING,
        machine.start(session.copy(sessionId = "session-${index + 2}"), 1_000, true, true).phase,
      )
    }
    assertEquals(MonitorFailure.SESSION_LIMIT, machine.start(session.copy(sessionId = "session-09"), 1_000, true, true).failure)

    assertEquals(MonitorPhase.PAUSED_DOZE, machine.onDoze(true, 2_000).phase)
    assertTrue(machine.snapshot.sessions.all { it.freshness == CacheFreshness.STALE })
    assertEquals(MonitorPhase.PAUSED_DOZE, machine.onNetworkAvailable(true, 2_500).phase)
    assertEquals(MonitorPhase.RUNNING, machine.onDoze(false, 3_000).phase)
    assertEquals(MonitorPhase.TIMED_OUT, machine.tick(6 * 60 * 60 * 1_000L + 1_001).phase)
    assertTrue(machine.snapshot.sessions.isEmpty())

    machine.start(session, 30_000_000, true, true)
    assertEquals(MonitorPhase.IDLE, machine.stop(MonitorStopReason.USER_STOP, 30_000_001).phase)
    assertEquals(MonitorStopReason.USER_STOP, machine.snapshot.stopReason)
  }

  @Test
  fun `permission revocation and network loss never imply live monitoring`() {
    val machine = ForegroundMonitorMachine()
    machine.start(session, 0, true, true)
    assertEquals(MonitorPhase.RECONNECTING, machine.onNetworkAvailable(false, 100).phase)
    assertEquals(
      CacheFreshness.RECONNECTING,
      machine.snapshot.sessions
        .single()
        .freshness,
    )
    assertEquals(MonitorPhase.RUNNING, machine.onNetworkAvailable(true, 200).phase)
    assertEquals(MonitorPhase.PERMISSION_DENIED, machine.onNotificationPermission(false, 300).phase)
    assertTrue(machine.snapshot.sessions.isEmpty())
    assertEquals(MonitorStopReason.PERMISSION_REVOKED, machine.snapshot.stopReason)
  }

  @Test
  fun `foundation models contain no notification content credentials commands or sockets`() {
    val forbidden = setOf("prompt", "message", "content", "bearer", "token", "credential", "command", "socket")
    val fields =
      listOf(
        NotificationEventId::class.java,
        CatchUpCandidate::class.java,
        ForegroundMonitorSnapshot::class.java,
      ).flatMap { type -> type.declaredFields.map { it.name.lowercase() } }
    assertTrue(fields.none { field -> forbidden.any(field::contains) }, fields.joinToString())
  }

  @Test
  fun `catch up enforces fifteen minute floor constraints dedupe mute and stale suppression`() {
    val transport = FakeCatchUpTransport()
    val ledger = NotificationDedupeLedger(16)
    val policy = NotificationPolicy(mutedSessions = setOf(SessionMuteKey(session.hostId, "muted")))
    val worker = CatchUpWorker(transport, ledger, policy, minimumIntervalMinutes = 15, staleAfterMillis = 5 * 60_000)

    assertThrows(IllegalArgumentException::class.java) {
      CatchUpWorker(transport, ledger, policy, minimumIntervalMinutes = 14)
    }
    val candidates =
      listOf(
        CatchUpCandidate(
          NotificationEventId(session, "fresh"),
          NotificationChannel.TERMINAL,
          observedAtMillis = 999_900,
          freshness = CacheFreshness.FRESH,
        ),
        CatchUpCandidate(
          NotificationEventId(session, "stale"),
          NotificationChannel.TERMINAL,
          observedAtMillis = 1_000,
          freshness = CacheFreshness.FRESH,
        ),
        CatchUpCandidate(
          NotificationEventId(session.copy(sessionId = "muted"), "muted"),
          NotificationChannel.ACTIVITY,
          observedAtMillis = 999_900,
          freshness = CacheFreshness.FRESH,
        ),
        CatchUpCandidate(
          NotificationEventId(session, "offline"),
          NotificationChannel.HOST_STATE,
          observedAtMillis = 999_900,
          freshness = CacheFreshness.OFFLINE_CACHED,
        ),
      )
    transport.result = candidates

    val first = worker.run(CatchUpConstraints(networkAvailable = true, batteryNotLow = true), nowMillis = 1_000_000, minuteOfDay = 12 * 60)
    assertEquals(listOf("fresh"), first.notifications.map { it.id.eventId })
    assertEquals(1, first.suppressedStale)
    assertEquals(1, first.suppressedPolicy)
    assertEquals(1, first.suppressedFreshness)
    assertEquals(1, transport.calls)

    val second = worker.run(CatchUpConstraints(true, true), nowMillis = 1_000_100, minuteOfDay = 12 * 60)
    assertTrue(second.notifications.isEmpty())
    assertEquals(1, second.suppressedDuplicate)

    val constrained = worker.run(CatchUpConstraints(networkAvailable = false, batteryNotLow = true), 2_000_000, 12 * 60)
    assertEquals(CatchUpSkipReason.NETWORK_UNAVAILABLE, constrained.skipReason)
    assertEquals(2, transport.calls, "constraints prevent transport execution")
  }
}

private class FakeCatchUpTransport : CatchUpTransport {
  var calls: Int = 0
  var result: List<CatchUpCandidate> = emptyList()

  override fun query(): List<CatchUpCandidate> {
    calls += 1
    return result
  }
}
