package com.harryaskham.pidroid.sdk.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

class PiDaemonSdkCoreContractTest {
  private val repositoryRoot: Path =
    Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val json = Json
  private val host =
    PiDaemonHostDescriptor(
      id = HostId("workstation"),
      displayName = "Workstation",
      baseUri = URI("https://daemon.example.test"),
    )

  @Test
  fun `service bearer request factory is bounded redacted and transport neutral`() {
    val secret = "fixture-service-bearer"
    val callerOwned = secret.toCharArray()
    val factory = ServiceBearerRequestFactory.create(host, callerOwned)
    callerOwned.fill('x')

    val request = factory.http(HttpMethod.GET, "/v1/capabilities")

    assertEquals(URI("https://daemon.example.test/v1/capabilities"), request.uri)
    assertEquals("Bearer $secret", request.headers["Authorization"])
    assertFalse(request.toString().contains(secret))
    assertFalse(request.headers.toString().contains(secret))
    assertFalse(request.hashCode().toString().contains(secret))
    assertFalse(factory.toString().contains(secret))
    assertThrows(IllegalArgumentException::class.java) {
      ServiceBearerRequestFactory.create(
        host.copy(baseUri = URI("http://daemon.example.test")),
        secret.toCharArray(),
      )
    }
    assertNotNull(
      ServiceBearerRequestFactory.create(
        host.copy(baseUri = URI("http://127.0.0.1:7463")),
        secret.toCharArray(),
      ),
    )

    factory.close()
    val closedError =
      assertThrows(IllegalStateException::class.java) {
        factory.http(HttpMethod.GET, "/v1/capabilities")
      }
    assertFalse(closedError.message.orEmpty().contains(secret))
  }

  @Test
  fun `capabilities fixture crosses injected HTTP transport with additive fields`() =
    runTest {
      val fixture = fixtureObject("fixtures/session-api/capabilities.response.json")
      val data =
        JsonObject(
          fixture.getValue("data").jsonObject +
            ("futureCapability" to JsonObject(mapOf("revision" to JsonPrimitive(2)))),
        )
      val responseBody = JsonObject(fixture + ("data" to data)).toString()
      val transport = FakeTransport(httpBody = responseBody)
      val client =
        PiDaemonClient(
          host = host,
          requestFactory =
            ServiceBearerRequestFactory.create(host, "fixture-service-bearer".toCharArray()),
          transport = transport,
        )

      val capabilities = client.capabilities().requireSuccess()

      assertEquals("1.0", capabilities.apiVersion)
      assertEquals("service-bearer", capabilities.authentication)
      assertTrue("websocket" in capabilities.transports)
      assertTrue("pi-daemon-rpc.v1" in capabilities.rpcSubprotocols)
      assertTrue("futureCapability" in capabilities.additionalFields)
      assertEquals("Bearer fixture-service-bearer", transport.lastHttpRequest?.headers?.get("Authorization"))
      assertEquals("/v1/capabilities", transport.lastHttpRequest?.uri?.path)
    }

  @Test
  fun `safe API errors and malformed bodies never echo response content`() {
    val fixture = fixtureObject("fixtures/session-api/error.response.json")
    val error =
      JsonObject(
        fixture.getValue("error").jsonObject +
          ("details" to JsonObject(mapOf("debugSecret" to JsonPrimitive("must-not-log")))),
      )
    val result =
      SessionApiCodec.decodeCapabilities(
        NeutralHttpResponse(
          status = 409,
          headers = NeutralHeaders.empty(),
          body = JsonObject(fixture + ("error" to error)).toString().encodeToByteArray(),
        ),
      )

    val safeError = result.requireFailure()
    assertEquals("stale_generation", safeError.code)
    assertFalse(result.toString().contains("must-not-log"))

    val malformedSecret = "Bearer malformed-secret"
    val thrown =
      assertThrows(ProtocolDecodeException::class.java) {
        SessionApiCodec.decodeCapabilities(
          NeutralHttpResponse(
            status = 500,
            headers = NeutralHeaders.empty(),
            body = malformedSecret.encodeToByteArray(),
          ),
        )
      }
    assertFalse(thrown.message.orEmpty().contains(malformedSecret))
  }

  @Test
  fun `ticket fixture preserves durable identity and terminal contract`() {
    val result =
      SessionApiCodec.decodeTicket(
        fixtureResponse("fixtures/session-api/ticket.response.json"),
      )

    val ticket = result.requireSuccess()
    assertEquals("ticket-create-agent-a", ticket.ticketId)
    assertEquals("create-agent-a-once", ticket.idempotencyKey)
    assertEquals(TicketState.QUEUED, ticket.state)
    assertEquals("agent-a", ticket.sessionId)
    assertEquals(1, ticket.generation)
    assertEquals("/v1/ticket/ticket-create-agent-a", ticket.links.getValue("self"))
  }

  @Test
  fun `framed RPC fixtures decode by kind without logging command content`() {
    val fixtures =
      mapOf(
        "fixtures/session-api/rpc.ready.frame.json" to SessionRpcFrame.AttachReady::class,
        "fixtures/session-api/rpc.command.frame.json" to SessionRpcFrame.Command::class,
        "fixtures/session-api/rpc.response.frame.json" to SessionRpcFrame.Response::class,
        "fixtures/session-api/rpc.event.frame.json" to SessionRpcFrame.Event::class,
        "fixtures/session-api/rpc.control.frame.json" to SessionRpcFrame.Control::class,
        "fixtures/session-api/rpc.replay-gap.frame.json" to SessionRpcFrame.ReplayGap::class,
      )

    for ((fixturePath, expectedType) in fixtures) {
      val text = Files.readString(repositoryRoot.resolve(fixturePath))
      val frame = SessionRpcFrameCodec.decode(text)
      assertEquals(expectedType, frame::class, fixturePath)
      if (fixturePath.endsWith("rpc.command.frame.json")) {
        assertFalse(frame.toString().contains("Continue the release audit"))
      }
    }

    val command =
      SessionRpcFrameCodec.decode(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.command.frame.json")),
      ) as SessionRpcFrame.Command
    val response =
      SessionRpcFrameCodec.decode(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.response.frame.json")),
      ) as SessionRpcFrame.Response
    val replayGap =
      SessionRpcFrameCodec.decode(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.replay-gap.frame.json")),
      ) as SessionRpcFrame.ReplayGap
    assertEquals("rpc-17", command.correlationId)
    assertEquals("rpc-state-1", response.correlationId)
    assertEquals("host-01:agent-a:3:45", replayGap.highWaterCursor)
    assertTrue(replayGap.snapshotFollows)

    val readyFixture = fixtureObject("fixtures/session-api/rpc.ready.frame.json")
    val futureReady = JsonObject(readyFixture + ("futureFrameField" to JsonPrimitive(true)))
    val ready = SessionRpcFrameCodec.decode(futureReady.toString()) as SessionRpcFrame.AttachReady
    assertEquals("host-01:agent-a:3:41", ready.highWaterCursor)
    assertTrue("futureFrameField" in ready.raw)

    val maliciousKind = "must not reach diagnostics"
    val malformed =
      assertThrows(ProtocolDecodeException::class.java) {
        SessionRpcFrameCodec.decode(JsonObject(mapOf("kind" to JsonPrimitive(maliciousKind))).toString())
      }
    assertFalse(malformed.message.orEmpty().contains(maliciousKind))
  }

  @Test
  fun `attach builds exact generation bound authenticated WebSocket request`() {
    val factory =
      ServiceBearerRequestFactory.create(host, "fixture-service-bearer".toCharArray())
    val transport = FakeTransport(httpBody = "{}")
    val client = PiDaemonClient(host, factory, transport)

    val socket =
      client.attach(
        session = SessionKey(sessionId = "agent:a", generation = 3),
        role = SessionRole.OBSERVER,
        cursor = "résumé + /?",
      )

    assertSame(transport.socket, socket)
    val request = requireNotNull(transport.lastWebSocketRequest)
    assertEquals("/v1/session/agent:a/rpc", request.uri.path)
    assertEquals("/v1/session/agent%3Aa/rpc", request.uri.rawPath)
    assertEquals("generation=3&role=observer&cursor=r%C3%A9sum%C3%A9+%2B+%2F%3F", request.uri.rawQuery)
    assertEquals(listOf("pi-daemon-rpc.v1"), request.subprotocols)
    assertEquals("Bearer fixture-service-bearer", request.headers["Authorization"])
    assertFalse(request.toString().contains("fixture-service-bearer"))
  }

  private fun fixtureObject(relativePath: String): JsonObject =
    json.parseToJsonElement(Files.readString(repositoryRoot.resolve(relativePath))).jsonObject

  private fun fixtureResponse(relativePath: String): NeutralHttpResponse =
    NeutralHttpResponse(
      status = 200,
      headers = NeutralHeaders.empty(),
      body = Files.readAllBytes(repositoryRoot.resolve(relativePath)),
    )

  private class FakeTransport(
    private val httpBody: String,
  ) : PiDaemonTransport {
    override val hosts: Flow<List<PiDaemonHostDescriptor>> = MutableStateFlow(emptyList())
    val socket = FakeSocket()
    var lastHttpRequest: NeutralHttpRequest? = null
    var lastWebSocketRequest: NeutralWebSocketRequest? = null

    override suspend fun execute(
      host: HostId,
      request: NeutralHttpRequest,
    ): NeutralHttpResponse {
      lastHttpRequest = request
      return NeutralHttpResponse(
        status = 200,
        headers = NeutralHeaders.empty(),
        body = httpBody.encodeToByteArray(),
      )
    }

    override fun openWebSocket(
      host: HostId,
      request: NeutralWebSocketRequest,
    ): PiDaemonSocket {
      lastWebSocketRequest = request
      return socket
    }
  }

  private class FakeSocket : PiDaemonSocket {
    override val incomingText: Flow<String> = MutableSharedFlow()

    override suspend fun sendText(text: String) = Unit

    override suspend fun close(
      code: Int,
      reason: String,
    ) = Unit
  }
}

private fun <T> ApiResult<T>.requireSuccess(): T =
  when (this) {
    is ApiResult.Success -> value
    is ApiResult.Failure -> throw AssertionError("expected success, got $this")
  }

private fun <T> ApiResult<T>.requireFailure(): SafeApiError =
  when (this) {
    is ApiResult.Success -> throw AssertionError("expected failure, got $this")
    is ApiResult.Failure -> error
  }
