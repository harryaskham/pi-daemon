package com.harryaskham.pidroid.sessionui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class TuiFrameReducerTest {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))

  @Test
  fun `snapshot is bounded normalized and identity exact`() {
    val state = TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(), TuiControlRole.OBSERVER)

    assertEquals(TuiSessionIdentity("host-fixture-01", "session-fixture-01", 3), state.identity)
    assertEquals(TuiDimensionsModel(rows = 24, columns = 80), state.dimensions)
    assertEquals(24, state.rows.size)
    assertEquals("Pi fixture", state.title)
    assertEquals("dash:fixture:host-fixture-01:session-fixture-01:3:40", state.highWaterCursor)
    assertEquals(TuiFramePhase.LIVE, state.phase)
    assertEquals(TuiControlRole.OBSERVER, state.role)
    assertFalse(state.canSendIntents)
    assertFalse(state.toString().contains("Pi Droid terminal"))
  }

  @Test
  fun `delta replaces only changed rows cursor title and high water sequence`() {
    val snapshot = TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(), TuiControlRole.CONTROLLER)
    val delta =
      TuiFrameDecoder.decodeDelta(
        Files.readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.tui-delta.json")),
      )

    val changed = TuiFrameReducer.applyDelta(snapshot, delta)

    assertEquals(41, changed.sequence)
    assertEquals("Pi fixture", changed.rows[0].plainText)
    assertEquals("Waiting for input", changed.rows[1].plainText)
    assertEquals(TuiCursorModel(row = 1, column = 0, visible = true, shape = TuiCursorShape.BLOCK), changed.cursor)
    assertEquals(delta.cursor, changed.highWaterCursor)
    assertEquals("Pi fixture", changed.title)
    assertTrue(changed.canSendIntents)
    assertEquals(changed, TuiFrameReducer.applyDelta(changed, delta), "duplicate sequence is idempotent")
  }

  @Test
  fun `sequence or identity mismatch requires a fresh snapshot`() {
    val snapshot = TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(), TuiControlRole.CONTROLLER)
    val skipped = TuiFrameDecoder.decodeDelta(TuiSurfaceTestFixtures.deltaJson(sequence = 43))
    val skippedState = TuiFrameReducer.applyDelta(snapshot.copy(sequence = 41), skipped)

    assertEquals(TuiFramePhase.REPLAY_GAP, skippedState.phase)
    assertEquals("sequence-gap", skippedState.gapReason)
    assertTrue(skippedState.rows.isEmpty())
    assertFalse(skippedState.canSendIntents)

    val wrongIdentity = TuiFrameDecoder.decodeDelta(TuiSurfaceTestFixtures.deltaJson(hostInstanceId = "other-host"))
    val error = assertThrows(TuiFrameException::class.java) { TuiFrameReducer.applyDelta(snapshot, wrongIdentity) }
    assertEquals("identity_mismatch", error.code)
  }

  @Test
  fun `replay gap discards stale frame and fresh snapshot recovers`() {
    val snapshot = TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(), TuiControlRole.CONTROLLER)
    val gap =
      TuiFrameDecoder.decodeReplayGap(
        Files.readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.replay-gap.json")),
      )
    val waiting = TuiFrameReducer.applyReplayGap(snapshot, gap)

    assertEquals(TuiFramePhase.REPLAY_GAP, waiting.phase)
    assertEquals("cursor-expired", waiting.gapReason)
    assertEquals(gap.highWaterCursor, waiting.highWaterCursor)
    assertTrue(waiting.rows.isEmpty())
    assertEquals(waiting, TuiFrameReducer.applyDelta(waiting, TuiFrameDecoder.decodeDelta(TuiSurfaceTestFixtures.deltaJson())))

    val recovered =
      TuiFrameReducer.applySnapshot(
        waiting,
        TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(), TuiControlRole.CONTROLLER),
      )
    assertEquals(TuiFramePhase.LIVE, recovered.phase)
    assertEquals(24, recovered.rows.size)
    assertTrue(recovered.canSendIntents)
  }

  @Test
  fun `decoder refuses oversized title rows cursor and malformed changed rows`() {
    assertEquals(
      "title_too_large",
      assertThrows(TuiFrameException::class.java) {
        TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(title = "x".repeat(257)), TuiControlRole.OBSERVER)
      }.code,
    )
    assertEquals(
      "dimensions_out_of_bounds",
      assertThrows(TuiFrameException::class.java) {
        TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(rows = 201), TuiControlRole.OBSERVER)
      }.code,
    )
    assertEquals(
      "cursor_out_of_bounds",
      assertThrows(TuiFrameException::class.java) {
        TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(cursorRow = 24), TuiControlRole.OBSERVER)
      }.code,
    )
    assertEquals(
      "row_out_of_bounds",
      assertThrows(TuiFrameException::class.java) {
        TuiFrameDecoder.decodeDelta(TuiSurfaceTestFixtures.deltaJson(changedRow = 24))
      }.code,
    )
  }

  @Test
  fun `input and resize intents remain inert without current controller authority`() {
    val observer = TuiFrameDecoder.decodeSnapshot(TuiSurfaceTestFixtures.snapshotJson(), TuiControlRole.OBSERVER)
    val controller = observer.copy(role = TuiControlRole.CONTROLLER)

    val blocked = TuiIntentReducer.input(observer, TuiInputModel.Key("Enter"))
    assertEquals(TuiIntentDisposition.REQUIRES_CONTROLLER, blocked.disposition)
    assertFalse(blocked.isDispatchable)

    val input = TuiIntentReducer.input(controller, TuiInputModel.Text("hello"))
    assertEquals(TuiIntentDisposition.READY, input.disposition)
    assertEquals(TuiInteractionIntent.Input(TuiInputModel.Text("hello")), input.intent)
    assertTrue(input.isDispatchable)

    val resize = TuiIntentReducer.resize(controller, TuiDimensionsModel(40, 120))
    assertEquals(TuiIntentDisposition.READY, resize.disposition)
    assertEquals(TuiInteractionIntent.Resize(TuiDimensionsModel(40, 120)), resize.intent)

    val resync = TuiFrameReducer.applyReplayGap(controller, TuiFrameDecoder.decodeReplayGap(TuiSurfaceTestFixtures.replayGapJson()))
    assertEquals(TuiIntentDisposition.RESYNC_REQUIRED, TuiIntentReducer.input(resync, TuiInputModel.Key("Enter")).disposition)
  }
}
