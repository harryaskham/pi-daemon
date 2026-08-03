package com.harryaskham.pidroid.sdk.core

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class InteractiveSessionContractTest {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val json = Json
  private val session = SessionKey("agent-a", 3)

  @Test
  fun `mutating command codec matches canonical Pi RPC conformance fixtures`() {
    val conformance =
      json
        .parseToJsonElement(
          Files.readString(repositoryRoot.resolve("fixtures/pi-rpc-conformance.json")),
        ).jsonObject
        .getValue("commands")
        .jsonArray
    val expected =
      conformance.associateBy { command ->
        command.jsonObject
          .getValue("type")
          .jsonPrimitive.content
      }
    val intents =
      listOf(
        SessionCommandIntent.prompt("hello"),
        SessionCommandIntent.steer("steer"),
        SessionCommandIntent.followUp("follow"),
        SessionCommandIntent.abort(),
        SessionCommandIntent.setModel("other", "other-model"),
        SessionCommandIntent.setThinkingLevel("max"),
        SessionCommandIntent.compact("compact"),
      )

    for ((index, intent) in intents.withIndex()) {
      val encoded = InteractiveCommandCodec.encode(intent, CorrelationId("command-$index"))
      val command =
        json
          .parseToJsonElement(encoded)
          .jsonObject
          .getValue("command")
          .jsonObject
      assertEquals("command-$index", command.getValue("id").jsonPrimitive.content)
      val canonical = expected.getValue(intent.kind.wireValue).jsonObject
      val expectedCommand = if (intent.kind == PiRpcCommandType.PROMPT) JsonObject(canonical - "images") else canonical
      assertEquals(expectedCommand, JsonObject(command - "id"), intent.kind.wireValue)
      assertFalse(encoded.contains("[REDACTED]"))
    }
    val sensitive = "must-not-reach-intent-rendering"
    assertFalse(SessionCommandIntent.prompt(sensitive).toString().contains(sensitive))
  }

  @Test
  fun `observer cannot submit mutation and explicit control grant unlocks it`() {
    val controller =
      InteractiveSessionController(
        session,
        supportedCommands = PiRpcCommandType.entries.toSet(),
        expectedHostInstanceId = "host-01",
      )
    controller.onFrame(attachReady(role = "observer"))

    val rejected =
      assertThrows(CommandAdmissionException::class.java) {
        controller.submit(SessionCommandIntent.prompt("secret prompt"), CorrelationId("prompt-1"))
      }
    assertEquals("controller_required", rejected.code)
    assertFalse(rejected.message.orEmpty().contains("secret prompt"))

    val request = controller.requestControl()
    assertEquals(
      "request_control",
      json
        .parseToJsonElement(request.text)
        .jsonObject
        .getValue("action")
        .jsonPrimitive.content,
    )
    controller.onFrame(controlFrame("control_granted"))

    val outbound = controller.submit(SessionCommandIntent.prompt("secret prompt"), CorrelationId("prompt-1"))
    assertEquals(CommandLifecycle.IN_FLIGHT, controller.command("prompt-1")?.lifecycle)
    assertFalse(outbound.toString().contains("secret prompt"))
  }

  @Test
  fun `response correlation settles once and disconnect makes unanswered commands indeterminate`() {
    val controller = readyController()
    controller.submit(SessionCommandIntent.steer("redirect"), CorrelationId("rpc-steer"))
    controller.submit(SessionCommandIntent.followUp("next"), CorrelationId("rpc-follow"))

    controller.onFrame(responseFrame("rpc-steer", success = true))
    assertEquals(CommandLifecycle.SUCCEEDED, controller.command("rpc-steer")?.lifecycle)

    controller.onDisconnect()
    assertEquals(CommandLifecycle.INDETERMINATE, controller.command("rpc-follow")?.lifecycle)
    assertFalse(controller.canReplay("rpc-follow"))
    assertThrows(CommandAdmissionException::class.java) {
      controller.submit(SessionCommandIntent.followUp("blind replay"), CorrelationId("rpc-follow"))
    }
  }

  @Test
  fun `replay gap invalidates authority until matching attach snapshot arrives`() {
    val controller = readyController()
    controller.submit(SessionCommandIntent.prompt("in flight"), CorrelationId("rpc-gap"))

    controller.onFrame(replayGap())

    assertEquals(InteractiveConnectionState.RESYNCING, controller.state.connection)
    assertEquals(CommandLifecycle.INDETERMINATE, controller.command("rpc-gap")?.lifecycle)
    assertThrows(CommandAdmissionException::class.java) {
      controller.submit(SessionCommandIntent.abort(), CorrelationId("abort-during-gap"))
    }

    controller.onFrame(attachReady(role = "controller"))
    assertEquals(InteractiveConnectionState.READY, controller.state.connection)
    assertEquals("host-01:agent-a:3:41", controller.state.highWaterCursor)

    val wrongHost =
      SessionRpcFrameCodec.decode(
        JsonObject(
          fixture("fixtures/session-api/rpc.ready.frame.json") +
            mapOf(
              "role" to JsonPrimitive("controller"),
              "hostInstanceId" to JsonPrimitive("host-replaced"),
            ),
        ).toString(),
      )
    assertEquals(
      "session_identity_mismatch",
      assertThrows(ProtocolDecodeException::class.java) { controller.onFrame(wrongHost) }.code,
    )
    assertEquals(InteractiveConnectionState.RESYNCING, controller.state.connection)
  }

  @Test
  fun `capabilities gate unsupported commands and in-flight work is bounded`() {
    val capabilities =
      SessionApiCodec
        .decodeCapabilities(
          NeutralHttpResponse(
            status = 200,
            headers = NeutralHeaders.empty(),
            body = Files.readAllBytes(repositoryRoot.resolve("fixtures/session-api/capabilities.response.json")),
          ),
        ).requireSuccess()
    val interactive = InteractiveCapabilities.from(capabilities)
    assertTrue(PiRpcCommandType.PROMPT in interactive.commands)
    assertTrue(interactive.schedules)

    val controller =
      InteractiveSessionController(
        session,
        interactive.commands,
        expectedHostInstanceId = "host-01",
        maxInFlight = 2,
      )
    controller.onFrame(attachReady(role = "controller"))
    controller.submit(SessionCommandIntent.prompt("one"), CorrelationId("one"))
    controller.submit(SessionCommandIntent.prompt("two"), CorrelationId("two"))
    val bounded =
      assertThrows(CommandAdmissionException::class.java) {
        controller.submit(SessionCommandIntent.prompt("three"), CorrelationId("three"))
      }
    assertEquals("too_many_in_flight", bounded.code)

    val limited =
      InteractiveSessionController(
        session,
        setOf(PiRpcCommandType.ABORT),
        expectedHostInstanceId = "host-01",
      )
    limited.onFrame(attachReady(role = "controller"))
    assertEquals(
      "unsupported_command",
      assertThrows(CommandAdmissionException::class.java) {
        limited.submit(SessionCommandIntent.prompt("unsupported"), CorrelationId("unsupported"))
      }.code,
    )
  }

  @Test
  fun `lazy draft remains runtime-free until exact first-send identity is supplied`() {
    val draft =
      LazySessionDraft.create(
        draftId = "draft-1",
        name = "Release audit",
        projectLabel = "fixture",
      )

    assertFalse(draft.materialized)
    assertEquals(null, draft.session)
    assertFalse(draft.toString().contains("prompt"))

    val materialized = draft.materialize(SessionKey("session-created", 1), "first-send-once")
    assertTrue(materialized.materialized)
    assertEquals("first-send-once", materialized.firstSendIdempotencyKey)
    assertThrows(IllegalStateException::class.java) {
      materialized.materialize(SessionKey("second", 1), "another-key")
    }
  }

  private fun readyController(): InteractiveSessionController =
    InteractiveSessionController(
      session,
      PiRpcCommandType.entries.toSet(),
      expectedHostInstanceId = "host-01",
    ).also {
      it.onFrame(attachReady(role = "controller"))
    }

  private fun attachReady(role: String): SessionRpcFrame {
    val root = fixture("fixtures/session-api/rpc.ready.frame.json")
    return SessionRpcFrameCodec.decode(JsonObject(root + ("role" to JsonPrimitive(role))).toString())
  }

  private fun replayGap(): SessionRpcFrame =
    SessionRpcFrameCodec.decode(Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.replay-gap.frame.json")))

  private fun controlFrame(action: String): SessionRpcFrame =
    SessionRpcFrameCodec.decode(
      JsonObject(
        mapOf(
          "kind" to JsonPrimitive("control"),
          "action" to JsonPrimitive(action),
          "connectionId" to JsonPrimitive("connection-4"),
        ),
      ).toString(),
    )

  private fun responseFrame(
    id: String,
    success: Boolean,
  ): SessionRpcFrame =
    SessionRpcFrameCodec.decode(
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
      ).toString(),
    )

  private fun fixture(relativePath: String): JsonObject =
    json.parseToJsonElement(Files.readString(repositoryRoot.resolve(relativePath))).jsonObject
}

private fun <T> ApiResult<T>.requireSuccess(): T =
  when (this) {
    is ApiResult.Success -> value
    is ApiResult.Failure -> throw AssertionError("expected fixture success, got $this")
  }
