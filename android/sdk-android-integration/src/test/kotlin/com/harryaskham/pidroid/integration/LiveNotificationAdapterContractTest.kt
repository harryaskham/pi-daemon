package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.SessionRpcFrameCodec
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class LiveNotificationAdapterContractTest {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val session = MonitoredSession(HostId("workstation"), "host-01", 0, "agent-a", 3)

  @Test
  fun `sdk frames map to content safe running terminal recovery and resync notifications`() {
    val fixture = Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.event.frame.json"))
    val secret = "NEVER_RENDER_THIS_MODEL_OUTPUT"
    val running =
      SessionNotificationSignalMapper.fromFrame(
        session,
        SessionRpcFrameCodec.decode(
          fixture
            .replace("message_update", "agent_start")
            .replace("Done", secret),
        ),
      )
    val settled =
      SessionNotificationSignalMapper.fromFrame(
        session,
        SessionRpcFrameCodec.decode(fixture.replace("message_update", "agent_settled")),
      )
    val ignored = SessionNotificationSignalMapper.fromFrame(session, SessionRpcFrameCodec.decode(fixture))
    val duplicateRunning =
      SessionNotificationSignalMapper.fromFrame(
        session,
        SessionRpcFrameCodec.decode(fixture.replace("message_update", "turn_start")),
      )
    val duplicateTerminal =
      SessionNotificationSignalMapper.fromFrame(
        session,
        SessionRpcFrameCodec.decode(fixture.replace("message_update", "agent_end")),
      )
    val ready =
      SessionNotificationSignalMapper.fromFrame(
        session,
        SessionRpcFrameCodec.decode(Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.ready.frame.json"))),
      )
    val gap =
      SessionNotificationSignalMapper.fromFrame(
        session,
        SessionRpcFrameCodec.decode(Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.replay-gap.frame.json"))),
      )

    assertEquals(SessionNotificationState.RUNNING, running?.state)
    assertEquals(SessionNotificationState.TERMINAL_SUCCEEDED, settled?.state)
    assertNull(ignored)
    assertNull(duplicateRunning)
    assertNull(duplicateTerminal)
    assertEquals(SessionNotificationState.HOST_RECOVERED, ready?.state)
    assertEquals(SessionNotificationState.RESYNCING, gap?.state)

    val projected = listOfNotNull(running, settled, ready, gap).map(ContentSafeNotificationProjector::project)
    assertTrue(projected.all { it.channel.contentSafe })
    assertTrue(projected.none { it.title.contains(secret) || it.body.contains(secret) })
    assertTrue(projected.all { it.toString().contains("content=[REDACTED]") })
  }

  @Test
  fun `wake disconnect input and failed terminal map without content`() {
    val wake = SessionNotificationSignalMapper.wakeQueued(session, "wake-request-01")
    val disconnected = SessionNotificationSignalMapper.hostDisconnected(session, "disconnect-01")
    val input = SessionNotificationSignalMapper.inputRequired(session, "input-01")
    val failed = SessionNotificationSignalMapper.terminal(session, "terminal-01", succeeded = false)
    assertEquals(SessionNotificationState.WAKING, wake.state)
    assertEquals(SessionNotificationState.HOST_DISCONNECTED, disconnected.state)
    assertEquals(SessionNotificationState.INPUT_REQUIRED, input.state)
    assertEquals(SessionNotificationState.TERMINAL_FAILED, failed.state)
    assertEquals(
      listOf(
        NotificationChannel.ACTIVITY,
        NotificationChannel.HOST_STATE,
        NotificationChannel.INPUT_REQUIRED,
        NotificationChannel.TERMINAL,
      ),
      listOf(wake, disconnected, input, failed).map { ContentSafeNotificationProjector.project(it).channel },
    )
  }

  @Test
  fun `emission applies exact policy and dedupe before returning a notification`() {
    val adapter =
      SessionNotificationAdapter(
        dedupe = NotificationDedupeLedger(16),
        policy = NotificationPolicy(quietHours = QuietHours(22 * 60, 7 * 60)),
      )
    val signal = SessionNotificationSignalMapper.terminal(session, "terminal-01", succeeded = true)
    assertNull(adapter.emit(signal, minuteOfDay = 23 * 60))
    val first = adapter.emit(signal, minuteOfDay = 12 * 60)
    assertEquals("Session completed", first?.title)
    assertNull(adapter.emit(signal, minuteOfDay = 12 * 60))
    assertEquals(signal.id, first?.id)
  }

  @Test
  fun `actions require exact fresh controller authority and never execute commands`() {
    val running = ContentSafeNotificationProjector.project(SessionNotificationSignalMapper.running(session, "running-01"))
    val terminal = ContentSafeNotificationProjector.project(SessionNotificationSignalMapper.terminal(session, "terminal-01", true))
    val freshController = NotificationAuthority(session, InteractiveControllerRole.CONTROLLER, CacheFreshness.FRESH)
    assertEquals(setOf(NotificationAction.OPEN, NotificationAction.ABORT), NotificationActionPolicy.actions(running, freshController))
    assertEquals(setOf(NotificationAction.OPEN, NotificationAction.FOLLOW_UP), NotificationActionPolicy.actions(terminal, freshController))
    assertEquals(
      setOf(NotificationAction.OPEN),
      NotificationActionPolicy.actions(running, freshController.copy(role = InteractiveControllerRole.OBSERVER)),
    )
    assertEquals(
      setOf(NotificationAction.OPEN),
      NotificationActionPolicy.actions(running, freshController.copy(freshness = CacheFreshness.STALE)),
    )
    assertEquals(
      setOf(NotificationAction.OPEN),
      NotificationActionPolicy.actions(running, freshController.copy(session = session.copy(generation = 4))),
    )
  }

  @Test
  fun `foreground adapter emits bounded dataSync start update and stop plans`() {
    val driver = FakeForegroundServiceDriver()
    val adapter = ForegroundServiceAdapter(ForegroundMonitorMachine(), driver)
    adapter.start(session, nowMillis = 0, userInitiated = true, notificationsGranted = true)
    assertEquals(listOf(ForegroundServiceDirective.START), driver.directives.map { it.directive })
    assertEquals(ForegroundServiceType.DATA_SYNC, driver.directives.single().serviceType)
    assertTrue(
      driver.directives
        .single()
        .notification.ongoing,
    )

    adapter.tick(50)
    assertEquals(1, driver.directives.size)
    adapter.onDoze(true, 100)
    assertEquals(ForegroundServiceDirective.UPDATE, driver.directives.last().directive)
    assertEquals(
      "Monitoring paused",
      driver.directives
        .last()
        .notification.title,
    )
    adapter.tick(6 * 60 * 60 * 1_000L + 1)
    assertEquals(ForegroundServiceDirective.STOP, driver.directives.last().directive)
    assertEquals(MonitorStopReason.SIX_HOUR_TIMEOUT, driver.directives.last().stopReason)
  }

  @Test
  fun `work adapter queries fake transport and sends only fresh deduped content safe records`() {
    val transport = FakeCatchUpTransportAdapter()
    val sink = FakeNotificationSink()
    val worker = CatchUpWorker(transport, NotificationDedupeLedger(16), NotificationPolicy())
    val adapter = WorkManagerCatchUpAdapter(worker, sink)
    transport.result =
      listOf(
        CatchUpCandidate(NotificationEventId(session, "terminal-01"), NotificationChannel.TERMINAL, 9_900, CacheFreshness.FRESH),
        CatchUpCandidate(NotificationEventId(session, "offline-01"), NotificationChannel.HOST_STATE, 9_900, CacheFreshness.OFFLINE_CACHED),
      )
    val result = adapter.run(CatchUpConstraints(true, true), 10_000, 12 * 60)
    assertEquals(1, result.notifications.size)
    assertEquals(1, sink.notifications.size)
    assertEquals("Session update", sink.notifications.single().title)
    assertTrue(
      sink.notifications
        .single()
        .channel.contentSafe,
    )
    assertEquals(1, result.suppressedFreshness)
  }
}

private class FakeForegroundServiceDriver : ForegroundServiceDriver {
  val directives = mutableListOf<ForegroundServicePlan>()

  override fun apply(plan: ForegroundServicePlan) {
    directives += plan
  }
}

private class FakeCatchUpTransportAdapter : CatchUpTransport {
  var result: List<CatchUpCandidate> = emptyList()

  override fun query(): List<CatchUpCandidate> = result
}

private class FakeNotificationSink : NotificationSink {
  val notifications = mutableListOf<ContentSafeNotification>()

  override fun notify(notification: ContentSafeNotification) {
    notifications += notification
  }
}
