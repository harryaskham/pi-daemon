package com.harryaskham.pidroid.sdk.core

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

class SessionLifecycleContractTest {
  private val repositoryRoot: Path = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val json: Json = Json
  private val host =
    PiDaemonHostDescriptor(
      id = HostId("workstation"),
      displayName = "Workstation",
      baseUri = URI("https://daemon.example.test"),
    )

  @Test
  fun `configured create uses only advertised server defaults and durable caller identity`() =
    runTest {
      val transport =
        RoutingTransport { request ->
          when (request.uri.path) {
            "/v1/dashboard/capabilities" -> fixtureBytes("fixtures/session-api/dashboard.capabilities.response.json")
            "/v1/session" -> fixtureBytes("fixtures/session-api/ticket.response.json")
            else -> error("unexpected route: ${request.uri.path}")
          }
        }
      val client = client(transport)
      val capabilities = client.dashboardCapabilities().success()

      assertEquals("/home/fixture", capabilities.configuredSessionDefaults?.cwd)
      assertEquals(ConfiguredSessionPersistence.PERSISTENT, capabilities.configuredSessionDefaults?.persistence)
      assertTrue(capabilities.configuredSessionDefaults.toString().contains("cwd=[SERVER-CONFIGURED]"))
      assertFalse(capabilities.toString().contains("/home/fixture"))

      val identity = DurableRequestIdentity("create-mobile-01", "create-mobile-once-01")
      val ticket = client.createConfiguredSession(capabilities, identity, sessionId = "mobile-01", name = "Daily driver").success()

      assertEquals("ticket-create-agent-a", ticket.ticketId)
      val request = transport.requests.last()
      assertEquals(HttpMethod.POST, request.method)
      assertEquals("application/json", request.headers["Content-Type"])
      assertEquals(identity.requestId, request.headers["X-Request-Id"])
      assertEquals(identity.idempotencyKey, request.headers["Idempotency-Key"])
      val body = json.parseToJsonElement(requireNotNull(request.bodyBytes()).decodeToString()).jsonObject
      assertEquals(identity.requestId, body.getValue("requestId").jsonPrimitive.content)
      assertEquals("mobile-01", body.getValue("sessionId").jsonPrimitive.content)
      val spec = body.getValue("spec").jsonObject
      assertEquals("/home/fixture", spec.getValue("cwd").jsonPrimitive.content)
      assertEquals(
        "new",
        spec
          .getValue("target")
          .jsonObject
          .getValue("mode")
          .jsonPrimitive.content,
      )
      assertEquals(
        "gpt-5.6-sol",
        spec
          .getValue("model")
          .jsonObject
          .getValue("id")
          .jsonPrimitive.content,
      )
      assertFalse("persistence" in spec)
      assertFalse("env" in spec)
      assertFalse(request.toString().contains("Daily driver"))
    }

  @Test
  fun `configured defaults require configured authority without imposing local path syntax`() {
    val windowsDefaults =
      SessionLifecycleCodec
        .decodeDashboardCapabilities(fixtureTextResponse(dashboardCapabilitiesDefaultsEnvelope("C:\\Users\\pi\\workspace", "configured")))
        .success()
    assertEquals("C:\\Users\\pi\\workspace", windowsDefaults.configuredSessionDefaults?.cwd)

    val failure =
      assertThrows(ProtocolDecodeException::class.java) {
        SessionLifecycleCodec.decodeDashboardCapabilities(
          fixtureTextResponse(dashboardCapabilitiesDefaultsEnvelope("/client/invented", "client")),
        )
      }
    assertEquals("unsupported_cwd_authority", failure.code)
  }

  @Test
  fun `list inspect adopt transcript observer and TUI flows preserve exact authority`() =
    runTest {
      val inventoryEnvelope = managedInventoryEnvelope(sessionId = "agent-a")
      val tuiCapabilitiesEnvelope = dashboardCapabilitiesEnvelope(tuiAvailable = true)
      val transport =
        RoutingTransport { request ->
          when (request.uri.path) {
            "/v1/session" -> {
              fixtureBytes("fixtures/session-api/list.response.json")
            }

            "/v1/session/agent-a" -> {
              fixtureBytes("fixtures/session-api/session.response.json")
            }

            "/v1/dashboard/inventory" -> {
              inventoryEnvelope.encodeToByteArray()
            }

            "/v1/dashboard/inventory/inventory-fixture-01" -> {
              fixtureBytes("fixtures/session-api/dashboard.info.response.json")
            }

            "/v1/dashboard/inventory/inventory-fixture-01/transcript" -> {
              fixtureBytes(
                "fixtures/session-api/dashboard.transcript.response.json",
              )
            }

            "/v1/dashboard/capabilities" -> {
              tuiCapabilitiesEnvelope.encodeToByteArray()
            }

            else -> {
              error("unexpected route: ${request.uri}")
            }
          }
        }
      val client = client(transport)

      val page = client.listSessions(limit = 50).success()
      assertEquals(SessionKey("agent-a", 3), page.sessions.single().key)
      assertEquals(
        "limit=50",
        transport.requests
          .last()
          .uri.rawQuery,
      )

      val inventory = client.listInventory(limit = 50).success()
      val record = inventory.sessions.single()
      val adopted = client.adoptExisting(record).success()
      assertEquals(SessionKey("agent-a", 3), adopted.session.key)
      assertEquals("inventory-fixture-01", adopted.inventoryId)

      val info = client.inventoryInfo(record.inventoryId).success()
      assertEquals("sha256:fixture-source-fingerprint", info.sourceFingerprint)
      val transcript = client.transcript(record.inventoryId, expectedFingerprint = info.sourceFingerprint).success()
      assertEquals(SessionKey("session-fixture-01", 3), transcript.observerSession)
      assertEquals(3, transcript.records.size)

      val observerSocket = client.attachObserver(transcript, cursor = "cursor-before", hydrate = true)
      assertSame(transport.socket, observerSocket)
      val observerRequest = requireNotNull(transport.webSockets.lastOrNull())
      assertEquals("/v1/session/session-fixture-01/rpc", observerRequest.uri.path)
      assertEquals("generation=3&role=observer&hydrate=true&cursor=cursor-before", observerRequest.uri.rawQuery)

      val unavailable =
        SessionLifecycleCodec
          .decodeTranscript(fixtureResponse("fixtures/session-api/dashboard.transcript.unavailable.response.json"))
          .success()
      assertNull(unavailable.observerSession)
      assertEquals(
        "observer_attach_unavailable",
        assertThrows(CapabilityUnavailableException::class.java) { client.attachObserver(unavailable) }.code,
      )

      val capabilities = client.dashboardCapabilities().success()
      val tuiSocket = client.attachTui(capabilities, SessionKey("session-fixture-01", 3), rows = 48, columns = 120)
      assertSame(transport.socket, tuiSocket)
      val tuiRequest = transport.webSockets.last()
      assertEquals("/v1/dashboard/session/session-fixture-01/tui", tuiRequest.uri.path)
      assertEquals("generation=3&role=observer&rows=48&columns=120", tuiRequest.uri.rawQuery)
      assertEquals(listOf("pi-daemon-tui.v1"), tuiRequest.subprotocols)
    }

  @Test
  fun `reuse activation and reconciliation are exact explicit mutations`() =
    runTest {
      val transport =
        RoutingTransport { request ->
          when (request.uri.path) {
            "/v1/dashboard/inventory" -> fixtureBytes("fixtures/session-api/dashboard.inventory.response.json")

            "/v1/dashboard/inventory/inventory-fixture-01/activate",
            "/v1/dashboard/activation/activation-fixture-01",
            -> fixtureBytes("fixtures/session-api/dashboard.activation.response.json")

            "/v1/ticket/ticket-create-agent-a",
            "/v1/ticket/ticket-create-agent-a/reconcile",
            -> fixtureBytes("fixtures/session-api/ticket.response.json")

            else -> error("unexpected route: ${request.method} ${request.uri.path}")
          }
        }
      val client = client(transport)
      val record =
        client
          .listInventory()
          .success()
          .sessions
          .single()
      val identity = DurableRequestIdentity("req-activation-01", "activation-fixture-01")
      val ticket = client.activateForReuse(record, identity, expectedFingerprint = "sha256:fixture-source-fingerprint").success()

      assertEquals(TicketState.SUCCEEDED, ticket.state)
      assertEquals(SessionKey("session-fixture-01", 3), ticket.managedSession)
      val request = transport.requests.last()
      assertEquals(identity.idempotencyKey, request.headers["Idempotency-Key"])
      val body = json.parseToJsonElement(requireNotNull(request.bodyBytes()).decodeToString()).jsonObject
      assertEquals("reuse", body.getValue("mode").jsonPrimitive.content)
      assertEquals("sha256:fixture-source-fingerprint", body.getValue("expectedFingerprint").jsonPrimitive.content)
      assertEquals(ticket.ticketId, client.activation(ticket.ticketId).success().ticketId)
      val durableTicket = client.ticket("ticket-create-agent-a").success()
      val reconciliationEvidence =
        TicketReconciliation.Failed(
          requestId = "reconcile-01",
          piEntryIds = listOf("entry-user-01", "entry-assistant-01"),
          code = "effect_not_observed",
          retryable = false,
        )
      assertEquals(
        durableTicket.ticketId,
        client.reconcileTicket(durableTicket.ticketId, reconciliationEvidence).success().ticketId,
      )
      val reconciliationRequest = transport.requests.last()
      assertEquals(HttpMethod.POST, reconciliationRequest.method)
      assertEquals("/v1/ticket/ticket-create-agent-a/reconcile", reconciliationRequest.uri.path)
      assertEquals("reconcile-01", reconciliationRequest.headers["X-Request-Id"])
      assertNull(reconciliationRequest.headers["Idempotency-Key"])

      val reconciliation = SessionLifecycleCodec.reconciliationBody(reconciliationEvidence)
      val reconciliationJson = json.parseToJsonElement(reconciliation.decodeToString()).jsonObject
      assertEquals("failed", reconciliationJson.getValue("state").jsonPrimitive.content)
      assertEquals(
        JsonArray(listOf(JsonPrimitive("entry-user-01"), JsonPrimitive("entry-assistant-01"))),
        reconciliationJson.getValue("evidence").jsonObject.getValue("piEntryIds"),
      )
      assertFalse(reconciliation.decodeToString().contains("client reconciliation marked"))
    }

  @Test
  fun `connection attempts process restore replay gaps and command IDs never auto replay`() {
    val session = SessionKey("agent-a", 3)
    val firstAttempt = ConnectionAttemptId("connect-1")
    val coordinator =
      SessionLifecycleCoordinator.create(
        hostId = host.id,
        hostInstanceId = "host-01",
        session = session,
        supportedCommands = PiRpcCommandType.entries.toSet(),
      )

    val firstAttach = coordinator.beginConnection(firstAttempt)
    assertEquals(SessionRole.OBSERVER, firstAttach.role)
    assertNull(firstAttach.cursor)
    coordinator.onFrame(firstAttempt, attachReady("controller"))
    coordinator.submit(firstAttempt, SessionCommandIntent.prompt("sensitive prompt"), CorrelationId("prompt-1"))
    assertEquals(CommandLifecycle.IN_FLIGHT, coordinator.command("prompt-1")?.lifecycle)
    assertFalse(coordinator.snapshot().toString().contains("sensitive prompt"))

    val encodedSnapshot = SessionResumeSnapshotCodec.encode(coordinator.snapshot())
    assertFalse(encodedSnapshot.decodeToString().contains("sensitive prompt"))
    val restored =
      SessionLifecycleCoordinator.restore(
        SessionResumeSnapshotCodec.decode(encodedSnapshot),
        PiRpcCommandType.entries.toSet(),
      )
    assertTrue(restored.state.processResumed)
    assertEquals(CommandLifecycle.INDETERMINATE, restored.command("prompt-1")?.lifecycle)
    assertFalse(restored.canReplay("prompt-1"))
    assertEquals(
      "duplicate_connection_attempt",
      assertThrows(CommandAdmissionException::class.java) { restored.beginConnection(firstAttempt) }.code,
    )

    val secondAttempt = ConnectionAttemptId("connect-2")
    assertEquals("host-01:agent-a:3:41", restored.beginConnection(secondAttempt).cursor)
    assertEquals(
      IncomingFrameDisposition.STALE_ATTEMPT_IGNORED,
      restored.onFrame(firstAttempt, attachReady("controller")),
    )
    assertEquals(
      IncomingFrameDisposition.RESYNC_REQUIRED,
      restored.onFrame(secondAttempt, attachReady("controller", sessionId = "wrong-session")),
    )
    assertNull(restored.state.replayCursor)
    assertEquals(InteractiveConnectionState.RESYNCING, restored.state.connection)
    restored.onFrame(secondAttempt, attachReady("controller"))
    assertEquals(
      "duplicate_correlation",
      assertThrows(CommandAdmissionException::class.java) {
        restored.submit(secondAttempt, SessionCommandIntent.prompt("blind replay"), CorrelationId("prompt-1"))
      }.code,
    )
    restored.submit(secondAttempt, SessionCommandIntent.prompt("new turn"), CorrelationId("prompt-2"))
    assertEquals(IncomingFrameDisposition.RESYNC_REQUIRED, restored.onFrame(secondAttempt, replayGap()))
    assertEquals(CommandLifecycle.INDETERMINATE, restored.command("prompt-2")?.lifecycle)
    assertNull(restored.state.replayCursor)
    assertEquals(InteractiveConnectionState.RESYNCING, restored.state.connection)
    assertFalse(restored.onDisconnect(firstAttempt))
    assertTrue(restored.onDisconnect(secondAttempt))
  }

  @Test
  fun `durable request identity collisions are rejected across process snapshots`() {
    val coordinator =
      SessionLifecycleCoordinator.create(
        hostId = host.id,
        session = SessionKey("agent-a", 3),
        supportedCommands = emptySet(),
      )
    val identity = DurableRequestIdentity("request-1", "key-1")
    assertFalse(identity.toString().contains("key-1"))
    coordinator.rememberRequest(identity)
    coordinator.rememberRequest(identity)
    assertEquals(
      "request_identity_conflict",
      assertThrows(CommandAdmissionException::class.java) {
        coordinator.rememberRequest(DurableRequestIdentity("request-1", "different-key"))
      }.code,
    )
    val decoded = SessionResumeSnapshotCodec.decode(SessionResumeSnapshotCodec.encode(coordinator.snapshot()))
    val restored = SessionLifecycleCoordinator.restore(decoded, emptySet())
    assertEquals(1, restored.snapshot().issuedRequests.size)
    assertEquals(
      "invalid_resume_snapshot",
      assertThrows(ProtocolDecodeException::class.java) {
        SessionResumeSnapshotCodec.decode(
          SessionResumeSnapshotCodec
            .encode(coordinator.snapshot())
            .decodeToString()
            .replaceFirst("{", "{\"prompt\":\"must-not-persist\",")
            .encodeToByteArray(),
        )
      }.code,
    )
  }

  private fun client(transport: RoutingTransport): PiDaemonClient =
    PiDaemonClient(
      host = host,
      requestFactory = ServiceBearerRequestFactory.create(host, "fixture-service-bearer".toCharArray()),
      transport = transport,
    )

  private fun attachReady(
    role: String,
    sessionId: String = "agent-a",
  ): SessionRpcFrame {
    val root = fixtureObject("fixtures/session-api/rpc.ready.frame.json")
    return SessionRpcFrameCodec.decode(
      JsonObject(root + ("role" to JsonPrimitive(role)) + ("sessionId" to JsonPrimitive(sessionId))).toString(),
    )
  }

  private fun replayGap(): SessionRpcFrame =
    SessionRpcFrameCodec.decode(Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.replay-gap.frame.json")))

  private fun managedInventoryEnvelope(sessionId: String): String {
    val root = fixtureObject("fixtures/session-api/dashboard.inventory.response.json")
    val data = root.getValue("data").jsonObject
    val sessions = data.getValue("sessions") as JsonArray
    val record = sessions.single().jsonObject
    val managed = record.getValue("managed").jsonObject
    val updatedRecord = JsonObject(record + ("managed" to JsonObject(managed + ("sessionId" to JsonPrimitive(sessionId)))))
    return JsonObject(root + ("data" to JsonObject(data + ("sessions" to JsonArray(listOf(updatedRecord)))))).toString()
  }

  private fun dashboardCapabilitiesDefaultsEnvelope(
    cwd: String,
    cwdSource: String,
  ): String {
    val root = fixtureObject("fixtures/session-api/dashboard.capabilities.response.json")
    val data = root.getValue("data").jsonObject
    val defaults = data.getValue("sessionDefaults").jsonObject
    val spec = defaults.getValue("spec").jsonObject
    val sources = defaults.getValue("sources").jsonObject
    val updatedDefaults =
      JsonObject(
        defaults +
          ("spec" to JsonObject(spec + ("cwd" to JsonPrimitive(cwd)))) +
          ("sources" to JsonObject(sources + ("cwd" to JsonPrimitive(cwdSource)))),
      )
    return JsonObject(root + ("data" to JsonObject(data + ("sessionDefaults" to updatedDefaults)))).toString()
  }

  private fun dashboardCapabilitiesEnvelope(tuiAvailable: Boolean): String {
    val root = fixtureObject("fixtures/session-api/dashboard.capabilities.response.json")
    val data = root.getValue("data").jsonObject
    val presentations = data.getValue("presentations").jsonObject
    val tui = presentations.getValue("tui").jsonObject
    val updatedTui = JsonObject((tui - "unavailableReason") + ("available" to JsonPrimitive(tuiAvailable)))
    val updatedPresentations = JsonObject(presentations + ("tui" to updatedTui))
    return JsonObject(root + ("data" to JsonObject(data + ("presentations" to updatedPresentations)))).toString()
  }

  private fun fixtureObject(relativePath: String): JsonObject =
    json.parseToJsonElement(Files.readString(repositoryRoot.resolve(relativePath))).jsonObject

  private fun fixtureBytes(relativePath: String): ByteArray = Files.readAllBytes(repositoryRoot.resolve(relativePath))

  private fun fixtureResponse(relativePath: String): NeutralHttpResponse =
    NeutralHttpResponse(200, NeutralHeaders.empty(), fixtureBytes(relativePath))

  private fun fixtureTextResponse(body: String): NeutralHttpResponse =
    NeutralHttpResponse(200, NeutralHeaders.empty(), body.encodeToByteArray())

  private class RoutingTransport(
    private val route: (NeutralHttpRequest) -> ByteArray,
  ) : PiDaemonTransport {
    override val hosts: Flow<List<PiDaemonHostDescriptor>> = MutableStateFlow(emptyList())
    val requests = mutableListOf<NeutralHttpRequest>()
    val webSockets = mutableListOf<NeutralWebSocketRequest>()
    val socket = FakeSocket()

    override suspend fun execute(
      host: HostId,
      request: NeutralHttpRequest,
    ): NeutralHttpResponse {
      requests += request
      return NeutralHttpResponse(200, NeutralHeaders.empty(), route(request))
    }

    override fun openWebSocket(
      host: HostId,
      request: NeutralWebSocketRequest,
    ): PiDaemonSocket {
      webSockets += request
      return socket
    }
  }

  private class FakeSocket : PiDaemonSocket {
    override val incomingText: Flow<String> = MutableSharedFlow()

    override suspend fun sendText(text: String): Unit = Unit

    override suspend fun close(
      code: Int,
      reason: String,
    ): Unit = Unit
  }
}

private fun <T> ApiResult<T>.success(): T =
  when (this) {
    is ApiResult.Success -> value
    is ApiResult.Failure -> throw AssertionError("expected success, got $this")
  }
