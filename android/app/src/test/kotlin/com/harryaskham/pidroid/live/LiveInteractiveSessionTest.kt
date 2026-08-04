package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import com.harryaskham.pidroid.sdk.core.CommandAdmissionException
import com.harryaskham.pidroid.sdk.core.CommandLifecycle
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import com.harryaskham.pidroid.sessionui.SessionTreeEntryKind
import com.harryaskham.pidroid.sessionui.TuiControlRole
import com.harryaskham.pidroid.sessionui.TuiFramePhase
import com.harryaskham.pidroid.sessionui.TuiInputModel
import com.harryaskham.pidroid.sessionui.TuiIntentDisposition
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class LiveInteractiveSessionTest {
  private val json = Json
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))

  @Test
  fun `observer remains readonly until explicit grant then unique prompt reconciles once`() {
    val session = machine()
    session.accept(attachReady("observer"))
    assertEquals(InteractiveConnectionState.READY, session.snapshot.connection)
    assertEquals(InteractiveControllerRole.OBSERVER, session.snapshot.role)
    assertFalse(session.snapshot.rich.canMutate)
    assertThrows(CommandAdmissionException::class.java) {
      session.submit(RichInteractionAction.SubmitPrompt("must not send"), "wake-unique-01")
    }

    val request = json.parseToJsonElement(session.requestControl()).jsonObject
    assertEquals("request_control", (request["action"] as JsonPrimitive).content)
    assertEquals(InteractiveControllerRole.REQUESTING, session.snapshot.role)
    session.accept(control("control_granted"))
    assertEquals(InteractiveControllerRole.CONTROLLER, session.snapshot.role)
    assertTrue(session.snapshot.rich.canMutate)

    val outbound =
      json
        .parseToJsonElement(
          session.submit(RichInteractionAction.SubmitPrompt("hello live daemon"), "wake-unique-01"),
        ).jsonObject
    val command = outbound.getValue("command").jsonObject
    assertEquals("wake-unique-01", (command["id"] as JsonPrimitive).content)
    assertEquals("prompt", (command["type"] as JsonPrimitive).content)
    assertEquals(
      CommandLifecycle.IN_FLIGHT,
      session.snapshot.receipts
        .single()
        .lifecycle,
    )
    assertThrows(CommandAdmissionException::class.java) {
      session.submit(RichInteractionAction.SubmitPrompt("blind duplicate"), "wake-unique-01")
    }

    session.accept(response("wake-unique-01", success = true))
    assertEquals(
      CommandLifecycle.SUCCEEDED,
      session.snapshot.receipts
        .single()
        .lifecycle,
    )
    session.accept(event("agent_start", 42))
    assertTrue(session.snapshot.streaming)
    session.accept(event("agent_settled", 43))
    assertFalse(session.snapshot.streaming)
    assertFalse(session.toString().contains("hello live daemon"))
  }

  @Test
  fun `disconnect and replay gap make missing acknowledgement indeterminate without replay`() {
    val session = machine()
    session.accept(attachReady("controller"))
    session.submit(RichInteractionAction.SubmitPrompt("one shot"), "wake-indeterminate-01")
    session.disconnected()
    assertEquals(InteractiveConnectionState.DISCONNECTED, session.snapshot.connection)
    assertEquals(
      CommandLifecycle.INDETERMINATE,
      session.snapshot.receipts
        .single()
        .lifecycle,
    )

    session.accept(attachReady("observer"))
    assertEquals(InteractiveControllerRole.OBSERVER, session.snapshot.role)
    assertThrows(CommandAdmissionException::class.java) {
      session.submit(RichInteractionAction.SubmitPrompt("blind replay"), "wake-indeterminate-01")
    }

    val fresh = machine()
    fresh.accept(attachReady("controller"))
    fresh.submit(RichInteractionAction.SubmitPrompt("gap"), "wake-gap-01")
    fresh.accept(repositoryRoot.resolve("fixtures/session-api/rpc.replay-gap.frame.json").toFile().readText())
    assertEquals(InteractiveConnectionState.RESYNCING, fresh.snapshot.connection)
    assertEquals(
      CommandLifecycle.INDETERMINATE,
      fresh.snapshot.receipts
        .single()
        .lifecycle,
    )
    assertThrows(CommandAdmissionException::class.java) {
      fresh.submit(RichInteractionAction.Abort, "abort-gap-01")
    }
  }

  @Test
  fun `tree response is bounded to exact identity and active leaf`() {
    val session = machine()
    session.accept(attachReady("controller"))
    val request =
      json
        .parseToJsonElement(session.requestTree("tree-query-01"))
        .jsonObject
        .getValue("command")
        .jsonObject
    assertEquals("get_tree", (request["type"] as JsonPrimitive).content)
    session.accept(treeResponse("tree-query-01"))

    val tree = requireNotNull(session.snapshot.tree)
    assertEquals("entry-assistant-01", tree.activeEntryId)
    assertEquals(3, tree.entries.size)
    assertEquals(SessionTreeEntryKind.SYSTEM, tree.entries.first().kind)
    assertTrue(tree.entries.single { it.id == "entry-assistant-01" }.active)
    assertFalse(tree.toString().contains("secret transcript text"))
  }

  @Test
  fun `canonical TUI observer is inert and replay gap requires a fresh snapshot`() {
    val tui = LiveTuiSessionMachine()
    tui.accept(tuiSnapshot(role = "observer"))
    assertEquals(TuiControlRole.OBSERVER, tui.state?.role)
    assertEquals(TuiIntentDisposition.REQUIRES_CONTROLLER, tui.input(TuiInputModel.Text("blocked")).disposition)

    tui.accept(tuiDelta(sequence = 1))
    assertEquals(
      "Prompt accepted",
      tui.state
        ?.rows
        ?.get(1)
        ?.plainText,
    )
    tui.accept(tuiReplayGap())
    assertEquals(TuiFramePhase.REPLAY_GAP, tui.state?.phase)
    assertEquals(TuiIntentDisposition.RESYNC_REQUIRED, tui.input(TuiInputModel.Key("Enter")).disposition)

    tui.accept(tuiSnapshot(role = "controller"))
    assertEquals(TuiFramePhase.LIVE, tui.state?.phase)
    assertEquals(TuiIntentDisposition.READY, tui.input(TuiInputModel.Text("ready")).disposition)
  }

  private fun machine(): LiveInteractiveSessionMachine =
    LiveInteractiveSessionMachine(
      session = SessionKey("agent-a", 3),
      supportedCommands = PiRpcCommandType.entries.toSet(),
      authority = HostAuthority(HostId("workstation"), 0, "host-01"),
      modelLabel = "fixture-model",
      thinkingLevel = "medium",
    )

  private fun attachReady(role: String): String {
    val root =
      json
        .parseToJsonElement(repositoryRoot.resolve("fixtures/session-api/rpc.ready.frame.json").toFile().readText())
        .jsonObject
    return JsonObject(root + ("role" to JsonPrimitive(role))).toString()
  }

  private fun control(action: String): String =
    JsonObject(
      mapOf(
        "kind" to JsonPrimitive("control"),
        "action" to JsonPrimitive(action),
        "connectionId" to JsonPrimitive("connection-4"),
      ),
    ).toString()

  private fun response(
    id: String,
    success: Boolean,
  ): String =
    JsonObject(
      mapOf(
        "kind" to JsonPrimitive("response"),
        "response" to
          JsonObject(
            mapOf(
              "id" to JsonPrimitive(id),
              "type" to JsonPrimitive("response"),
              "command" to JsonPrimitive("prompt"),
              "success" to JsonPrimitive(success),
            ),
          ),
      ),
    ).toString()

  private fun event(
    type: String,
    sequence: Int,
  ): String =
    JsonObject(
      mapOf(
        "kind" to JsonPrimitive("event"),
        "cursor" to JsonPrimitive("host-01:agent-a:3:$sequence"),
        "sequence" to JsonPrimitive(sequence),
        "event" to JsonObject(mapOf("type" to JsonPrimitive(type))),
      ),
    ).toString()

  private fun treeResponse(id: String): String =
    JsonObject(
      mapOf(
        "kind" to JsonPrimitive("response"),
        "response" to
          JsonObject(
            mapOf(
              "id" to JsonPrimitive(id),
              "type" to JsonPrimitive("response"),
              "command" to JsonPrimitive("get_tree"),
              "success" to JsonPrimitive(true),
              "data" to
                JsonObject(
                  mapOf(
                    "leafId" to JsonPrimitive("entry-assistant-01"),
                    "tree" to
                      JsonArray(
                        listOf(
                          treeNode(
                            "entry-system-01",
                            null,
                            "session_info",
                            "Session start",
                            treeNode(
                              "entry-user-01",
                              "entry-system-01",
                              "message",
                              "User",
                              treeNode("entry-assistant-01", "entry-user-01", "message", "Assistant"),
                            ),
                          ),
                        ),
                      ),
                  ),
                ),
            ),
          ),
      ),
    ).toString()

  private fun treeNode(
    id: String,
    parentId: String?,
    type: String,
    label: String,
    vararg children: JsonObject,
  ): JsonObject =
    JsonObject(
      mapOf(
        "entry" to
          JsonObject(
            mapOf(
              "id" to JsonPrimitive(id),
              "parentId" to (parentId?.let(::JsonPrimitive) ?: JsonNull),
              "type" to JsonPrimitive(type),
              "content" to JsonPrimitive("secret transcript text"),
            ),
          ),
        "label" to JsonPrimitive(label),
        "children" to JsonArray(children.toList()),
      ),
    )

  private fun tuiSnapshot(role: String): String =
    """{"kind":"snapshot","role":"$role","snapshot":{"identity":{"hostInstanceId":"host-01","sessionId":"agent-a","generation":3},"dimensions":{"rows":3,"columns":40},"rows":[{"row":0,"runs":[{"text":"Pi Droid interactive"}]}],"cursor":{"row":1,"column":0,"visible":true,"shape":"block"},"title":"Pi Droid","highWaterCursor":"tui:0"}}"""

  private fun tuiDelta(sequence: Int): String =
    """{"kind":"delta","delta":{"kind":"tui_delta","identity":{"hostInstanceId":"host-01","sessionId":"agent-a","generation":3},"cursor":"tui:$sequence","sequence":$sequence,"dimensions":{"rows":3,"columns":40},"changedRows":[{"row":1,"runs":[{"text":"Prompt accepted"}]}],"cursorState":{"row":2,"column":0,"visible":true,"shape":"block"},"title":"Pi Droid"}}"""

  private fun tuiReplayGap(): String =
    """{"kind":"replay_gap","gap":{"kind":"replay_gap","identity":{"hostInstanceId":"host-01","sessionId":"agent-a","generation":3},"reason":"cursor_expired","requestedCursor":"tui:0","highWaterCursor":"tui:2","oldestAvailableCursor":"tui:1","snapshotFollows":true}}"""
}
