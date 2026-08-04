package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.safeInteractiveFailureCode
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.CommandAdmissionException
import com.harryaskham.pidroid.sdk.core.CommandLifecycle
import com.harryaskham.pidroid.sdk.core.CredentialHandle
import com.harryaskham.pidroid.sdk.core.CredentialProtector
import com.harryaskham.pidroid.sdk.core.CredentialStorageClass
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HostRegistryStore
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.NeutralHeaders
import com.harryaskham.pidroid.sdk.core.NeutralHttpRequest
import com.harryaskham.pidroid.sdk.core.NeutralHttpResponse
import com.harryaskham.pidroid.sdk.core.NeutralWebSocketRequest
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.PiDaemonSocket
import com.harryaskham.pidroid.sdk.core.ProtectedCredential
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.nio.file.Path

@OptIn(ExperimentalCoroutinesApi::class)
class LiveReadonlyRepositoryTest {
  @Test
  fun `manual registration projects real neutral fixtures and clears caller bearer`() =
    runTest {
      val harness = harness()
      val bearer = "disposable-bearer".toCharArray()
      harness.repository.registerManual(
        apiUri = URI("http://10.0.2.2:48123"),
        displayName = "Disposable daemon",
        bearer = bearer,
        tlsFingerprint = null,
        confirmInsecureHttp = true,
      )

      assertTrue(bearer.all { it == '\u0000' })
      val ready = harness.repository.state.value as LiveReadonlyState.Ready
      assertEquals(CacheFreshness.FRESH, ready.selected.session.host.freshness)
      assertEquals("Contract fixture", ready.selected.session.session.title)
      assertEquals(1, ready.selected.session.inventory.size)
      assertEquals(3, ready.selected.session.records.size)
      assertTrue(ready.selected.rpcObserverConnected)
      assertTrue(harness.transport.paths.contains("/v1/capabilities"))
      assertTrue(harness.transport.paths.contains("/v1/dashboard/inventory"))
      assertTrue(harness.transport.authorizationObserved)
      assertFalse(harness.repository.toString().contains("disposable-bearer"))
    }

  @Test
  fun `host replacement emits resync and failed refresh retains offline cache`() =
    runTest {
      val harness = harness()
      harness.repository.registerManual(
        URI("http://10.0.2.2:48123"),
        "Disposable daemon",
        "bearer".toCharArray(),
        null,
        true,
      )
      val emissions = mutableListOf<LiveReadonlyState>()
      val collector =
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
          harness.repository.state.collect(emissions::add)
        }

      harness.transport.hostInstanceId = "host-fixture-02"
      harness.repository.refresh()
      assertTrue(
        emissions
          .filterIsInstance<LiveReadonlyState.Ready>()
          .any { it.selected.session.host.freshness == CacheFreshness.RESYNCING },
      )
      var ready = harness.repository.state.value as LiveReadonlyState.Ready
      assertEquals("host-fixture-02", ready.selected.session.host.authority.hostInstanceId)
      assertEquals(CacheFreshness.FRESH, ready.selected.session.host.freshness)

      harness.transport.fail = true
      harness.repository.refresh()
      ready = harness.repository.state.value as LiveReadonlyState.Ready
      assertEquals(CacheFreshness.OFFLINE_CACHED, ready.selected.session.host.freshness)
      assertFalse(ready.selected.rpcObserverConnected)
      collector.cancel()
    }

  @Test
  fun `interactive error mapper preserves only bounded lowercase typed codes`() {
    val secret = "https://secret.example/private response body"
    assertEquals(
      "session_not_ready",
      safeInteractiveFailureCode(CommandAdmissionException("session_not_ready", secret)),
    )
    assertEquals(
      "controller_required",
      safeInteractiveFailureCode(CommandAdmissionException("controller_required", secret)),
    )
    assertEquals(
      "interactive_failed",
      safeInteractiveFailureCode(CommandAdmissionException("SESSION_NOT_READY", secret)),
    )
    assertEquals(
      "interactive_failed",
      safeInteractiveFailureCode(CommandAdmissionException("x".repeat(129), secret)),
    )
    assertEquals("interactive_failed", safeInteractiveFailureCode(IllegalStateException(secret)))
    assertFalse(safeInteractiveFailureCode(IllegalStateException(secret)).contains("secret.example"))
  }

  @Test
  fun `connecting and pre-active failure remain observable instead of collapsing to observer`() {
    val hostId = HostId("workstation")
    assertEquals(
      "ACTION RECEIVED · CONNECTING",
      liveInteractiveStatusLabel(LiveInteractiveAppState.Connecting(hostId), hostId, rpcObserverConnected = true),
    )

    val unsafeHarness = harness()
    unsafeHarness.repository.reportInteractiveFailure("http://secret.example/private path response body")
    val redacted = unsafeHarness.repository.interactiveState.value as LiveInteractiveAppState.Failure
    assertEquals("interactive_failed", redacted.code)
    assertEquals(
      "INTERACTIVE ERROR · PREFLIGHT_ERROR · INTERACTIVE_FAILED",
      liveInteractiveStatusLabel(redacted, hostId, rpcObserverConnected = true),
    )
    assertFalse(redacted.toString().contains("secret.example"))

    val strongHarness = harness()
    strongHarness.repository.reportInteractiveFailure("observer_attach_failed")
    var failure = strongHarness.repository.interactiveState.value as LiveInteractiveAppState.Failure
    assertEquals("observer_attach_failed", failure.code)
    assertNull(failure.lastSnapshot)
    assertEquals(
      "INTERACTIVE ERROR · PREFLIGHT_ERROR · OBSERVER_ATTACH_FAILED",
      liveInteractiveStatusLabel(failure, hostId, rpcObserverConnected = true),
    )
    strongHarness.repository.reportInteractiveFailure("interactive_failed")
    failure = strongHarness.repository.interactiveState.value as LiveInteractiveAppState.Failure
    assertEquals("observer_attach_failed", failure.code, "generic catch must not downgrade a stronger stage failure")
  }

  @Test
  fun `unknown attach failure persists typed stage without exception content`() =
    runTest {
      val harness = harness()
      harness.repository.registerManual(
        URI("http://10.0.2.2:48123"),
        "Disposable daemon",
        "bearer".toCharArray(),
        null,
        true,
      )
      harness.transport.unexpectedExecuteFailure = true
      val error = runCatching { harness.repository.connectInteractiveObserver() }.exceptionOrNull()
      assertEquals("interactive_attach_failed", (error as LiveReadonlyFailure).code)
      harness.repository.reportInteractiveFailure(safeInteractiveFailureCode(error))
      val failure = harness.repository.interactiveState.value as LiveInteractiveAppState.Failure
      assertEquals("interactive_attach_failed", failure.code)
      assertFalse(failure.toString().contains("secret.example"))
      harness.repository.reportInteractiveFailure("interactive_failed")
      assertEquals(
        "interactive_attach_failed",
        (harness.repository.interactiveState.value as LiveInteractiveAppState.Failure).code,
      )
    }

  @Test
  fun `interactive observer attach stages are bounded and concurrent connect is deduped`() =
    runTest {
      suspend fun stageFailure(configure: (FakeLiveTransport) -> Unit): String {
        val harness = harness()
        harness.repository.registerManual(
          URI("http://10.0.2.2:48123"),
          "Disposable daemon",
          "bearer".toCharArray(),
          null,
          true,
        )
        configure(harness.transport)
        return (runCatching { harness.repository.connectInteractiveObserver() }.exceptionOrNull() as LiveReadonlyFailure).code
      }

      assertEquals("interactive_attach_failed", stageFailure { it.unexpectedExecuteFailure = true })
      assertEquals("observer_connect_failed", stageFailure { it.failRpcOpen = true })
      assertEquals("observer_connect_failed", stageFailure { it.failRpcReady = true })
      assertEquals("interactive_attach_failed", stageFailure { it.failTuiOpen = true })

      val harness = harness()
      harness.repository.registerManual(
        URI("http://10.0.2.2:48123"),
        "Disposable daemon",
        "bearer".toCharArray(),
        null,
        true,
      )
      val rpcOpensBefore = harness.transport.rpcOpenCount
      val tuiOpensBefore = harness.transport.tuiOpenCount
      coroutineScope {
        val first = async { harness.repository.connectInteractiveObserver() }
        val second = async { harness.repository.connectInteractiveObserver() }
        first.await()
        second.await()
      }
      assertEquals(rpcOpensBefore + 1, harness.transport.rpcOpenCount)
      assertEquals(tuiOpensBefore + 1, harness.transport.tuiOpenCount)
      val ready = harness.repository.interactiveState.value as LiveInteractiveAppState.Ready
      assertEquals(InteractiveConnectionState.READY, ready.snapshot.connection)
      assertEquals(InteractiveControllerRole.OBSERVER, ready.snapshot.role)
    }

  @Test
  fun `send failure persists indeterminate stage and forbids retry`() =
    runTest {
      val harness = harness()
      harness.repository.registerManual(
        URI("http://10.0.2.2:48123"),
        "Disposable daemon",
        "bearer".toCharArray(),
        null,
        true,
      )
      harness.repository.connectInteractiveObserver()
      harness.repository.requestControl()
      val rpcSocket = requireNotNull(harness.transport.interactiveRpcSocket)
      rpcSocket.push(controlGranted())
      withTimeout(5_000) {
        harness.repository.interactiveState
          .filterIsInstance<LiveInteractiveAppState.Ready>()
          .first {
            it.snapshot.role == InteractiveControllerRole.CONTROLLER &&
              it.snapshot.receipts.any { receipt -> receipt.kind.wireValue == "get_tree" }
          }
      }
      rpcSocket.failSend = true
      val sentBefore = rpcSocket.sent.size
      val error =
        runCatching {
          harness.repository.handleInteraction(RichInteractionAction.SubmitPrompt("must become indeterminate"))
        }.exceptionOrNull()
      assertEquals("interactive_send_indeterminate", (error as LiveReadonlyFailure).code)
      var failure = harness.repository.interactiveState.value as LiveInteractiveAppState.Failure
      assertEquals("interactive_send_indeterminate", failure.code)
      val receipt = requireNotNull(failure.lastSnapshot).receipts.last()
      assertEquals(CommandLifecycle.INDETERMINATE, receipt.lifecycle)
      assertEquals(sentBefore, rpcSocket.sent.size)
      harness.repository.reportInteractiveFailure("interactive_failed")
      failure = harness.repository.interactiveState.value as LiveInteractiveAppState.Failure
      assertEquals("interactive_send_indeterminate", failure.code)

      val retry =
        runCatching {
          harness.repository.handleInteraction(RichInteractionAction.SubmitPrompt("blind retry forbidden"))
        }.exceptionOrNull() as CommandAdmissionException
      assertEquals("session_not_ready", retry.code)
      assertEquals(sentBefore, rpcSocket.sent.size)
    }

  @Test
  fun `interactive repository requests control sends one unique prompt and marks lost response indeterminate`() =
    runTest {
      val harness = harness()
      harness.repository.registerManual(
        URI("http://10.0.2.2:48123"),
        "Disposable daemon",
        "bearer".toCharArray(),
        null,
        true,
      )

      harness.repository.connectInteractiveObserver()
      var interactive = harness.repository.interactiveState.value as LiveInteractiveAppState.Ready
      assertEquals(InteractiveConnectionState.READY, interactive.snapshot.connection)
      assertEquals(InteractiveControllerRole.OBSERVER, interactive.snapshot.role)
      assertEquals(
        "OBSERVER · READY",
        liveInteractiveStatusLabel(interactive, interactive.hostId, rpcObserverConnected = true),
      )
      val rpcOpens = harness.transport.rpcOpenCount
      val tuiOpens = harness.transport.tuiOpenCount
      harness.repository.requestControl()
      assertEquals(rpcOpens, harness.transport.rpcOpenCount, "request control must reuse ready observer RPC")
      assertEquals(tuiOpens, harness.transport.tuiOpenCount, "request control must reuse ready observer TUI")
      interactive = harness.repository.interactiveState.value as LiveInteractiveAppState.Ready
      assertEquals(InteractiveControllerRole.REQUESTING, interactive.snapshot.role)
      assertEquals(
        "REQUESTING",
        liveInteractiveStatusLabel(interactive, interactive.hostId, rpcObserverConnected = true),
      )
      val rpcSocket = requireNotNull(harness.transport.interactiveRpcSocket)
      assertTrue(rpcSocket.sent.single().contains("request_control"))

      rpcSocket.push(controlGranted())
      interactive =
        withTimeout(5_000) {
          harness.repository.interactiveState
            .filterIsInstance<LiveInteractiveAppState.Ready>()
            .first { it.snapshot.role == InteractiveControllerRole.CONTROLLER }
        }
      assertTrue(interactive.snapshot.rich.canMutate)
      assertEquals(
        "CONTROLLER",
        liveInteractiveStatusLabel(interactive, interactive.hostId, rpcObserverConnected = true),
      )

      harness.repository.handleInteraction(RichInteractionAction.SubmitPrompt("one exact prompt"))
      val prompt =
        Json
          .parseToJsonElement(rpcSocket.sent.last())
          .jsonObject
          .getValue("command")
          .jsonObject
      val promptId = (prompt["id"] as JsonPrimitive).content
      assertTrue(promptId.startsWith("wake-"))
      assertEquals("prompt", (prompt["type"] as JsonPrimitive).content)
      rpcSocket.push(response(promptId, success = true))
      withTimeout(5_000) {
        harness.repository.interactiveState
          .filterIsInstance<LiveInteractiveAppState.Ready>()
          .first {
            it.snapshot.receipts.any { receipt ->
              receipt.correlationId == promptId &&
                receipt.lifecycle == CommandLifecycle.SUCCEEDED
            }
          }
      }

      harness.repository.handleInteraction(RichInteractionAction.SubmitPrompt("lost acknowledgement"))
      val lostPrompt =
        Json
          .parseToJsonElement(rpcSocket.sent.last())
          .jsonObject
          .getValue("command")
          .jsonObject
      val lostId = (lostPrompt["id"] as JsonPrimitive).content
      assertTrue(lostId.startsWith("wake-"))
      assertFalse(lostId == promptId)
      rpcSocket.disconnect()
      val failed =
        withTimeout(5_000) {
          harness.repository.interactiveState
            .filterIsInstance<LiveInteractiveAppState.Failure>()
            .first()
        }
      assertEquals(
        CommandLifecycle.INDETERMINATE,
        requireNotNull(failed.lastSnapshot)
          .receipts
          .single { it.correlationId == lostId }
          .lifecycle,
      )
    }

  private fun controlGranted(): String =
    JsonObject(
      mapOf(
        "kind" to JsonPrimitive("control"),
        "action" to JsonPrimitive("control_granted"),
        "connectionId" to JsonPrimitive("connection-live"),
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

  private fun harness(): Harness {
    val protector = FakeProtector()
    val credentialStore = FakeCredentialStore()
    val vault = HostCredentialVault(protector, credentialStore)
    val registryStore = FakeHostStore()
    val registry = HostRegistry(registryStore, vault) { HostId("workstation") }
    val transport = FakeLiveTransport()
    val repository = LiveReadonlyRepository(registry, vault, transport)
    return Harness(repository, transport)
  }

  private data class Harness(
    val repository: LiveReadonlyRepository,
    val transport: FakeLiveTransport,
  )

  private class FakeHostStore : HostRegistryStore {
    private val hosts = linkedMapOf<HostId, RegisteredHost>()

    override suspend fun list(): List<RegisteredHost> = hosts.values.toList()

    override suspend fun upsert(host: RegisteredHost) {
      hosts[host.id] = host
    }

    override suspend fun remove(hostId: HostId) {
      hosts.remove(hostId)
    }
  }

  private class FakeProtector : CredentialProtector {
    override suspend fun protect(
      handle: CredentialHandle,
      bearer: CharArray,
    ): ProtectedCredential = ProtectedCredential.fromBytes(bearer.concatToString().encodeToByteArray())

    override suspend fun reveal(
      handle: CredentialHandle,
      credential: ProtectedCredential,
    ): CharArray = credential.copyBytes().decodeToString().toCharArray()

    override suspend fun destroy(handle: CredentialHandle) = Unit
  }

  private class FakeCredentialStore : com.harryaskham.pidroid.sdk.core.NoBackupCredentialStore {
    override val storageClass: CredentialStorageClass = CredentialStorageClass.NO_BACKUP
    private val entries = linkedMapOf<CredentialHandle, ProtectedCredential>()

    override suspend fun write(
      handle: CredentialHandle,
      credential: ProtectedCredential,
    ) {
      entries[handle] = credential
    }

    override suspend fun read(handle: CredentialHandle): ProtectedCredential? = entries[handle]

    override suspend fun remove(handle: CredentialHandle) {
      entries.remove(handle)
    }
  }

  private class FakeLiveTransport : LiveHostTransport {
    override val hosts: Flow<List<PiDaemonHostDescriptor>> = MutableStateFlow(emptyList())
    var hostInstanceId: String = "host-fixture-01"
    var fail: Boolean = false
    var unexpectedExecuteFailure: Boolean = false
    var authorizationObserved: Boolean = false
    var interactiveRpcSocket: FakeSocket? = null
    var rpcOpenCount: Int = 0
    var tuiOpenCount: Int = 0
    var failRpcOpen: Boolean = false
    var failRpcReady: Boolean = false
    var failTuiOpen: Boolean = false
    val paths = mutableListOf<String>()

    override fun replaceHosts(hosts: List<RegisteredHost>) = Unit

    override suspend fun execute(
      host: HostId,
      request: NeutralHttpRequest,
    ): NeutralHttpResponse {
      if (unexpectedExecuteFailure) throw IllegalStateException("https://secret.example/private response body")
      if (fail) throw TransportFailure("disposable_offline")
      authorizationObserved = request.headers["Authorization"]?.startsWith("Bearer ") == true
      paths += request.uri.path
      val fixture =
        when (request.uri.path) {
          "/v1/capabilities" -> "fixtures/session-api/capabilities.response.json"
          "/v1/dashboard/inventory" -> "fixtures/session-api/dashboard.inventory.response.json"
          "/v1/dashboard/inventory/inventory-fixture-01" -> "fixtures/session-api/dashboard.info.response.json"
          "/v1/dashboard/inventory/inventory-fixture-01/transcript" -> "fixtures/session-api/dashboard.transcript.response.json"
          else -> error("unexpected request path ${request.uri.path}")
        }
      var body = repositoryRoot.resolve(fixture).toFile().readText()
      body = body.replace("host-01", hostInstanceId).replace("host-fixture-01", hostInstanceId)
      return NeutralHttpResponse(200, NeutralHeaders.empty(), body.encodeToByteArray())
    }

    override fun openWebSocket(
      host: HostId,
      request: NeutralWebSocketRequest,
    ): PiDaemonSocket {
      val socket = FakeSocket()
      if (request.subprotocols.contains("pi-daemon-tui.v1")) {
        tuiOpenCount += 1
        if (failTuiOpen) throw IllegalStateException("https://secret.example/private tui response")
        socket.push(
          """{"kind":"snapshot","role":"observer","snapshot":{"identity":{"hostInstanceId":"$hostInstanceId","sessionId":"session-fixture-01","generation":3},"dimensions":{"rows":3,"columns":40},"rows":[{"row":0,"runs":[{"text":"Pi Droid interactive"}]}],"cursor":{"row":1,"column":0,"visible":true,"shape":"block"},"title":"Fixture","highWaterCursor":"tui:0"}}""",
        )
      } else {
        rpcOpenCount += 1
        if (failRpcOpen) throw IllegalStateException("https://secret.example/private rpc open")
        var frame = repositoryRoot.resolve("fixtures/session-api/rpc.ready.frame.json").toFile().readText()
        frame =
          frame
            .replace("host-01", hostInstanceId)
            .replace("agent-a", "session-fixture-01")
        if (failRpcReady) {
          socket.disconnect()
        } else {
          socket.push(frame)
        }
        if (interactiveRpcSocket == null || interactiveRpcSocket?.closed == true) {
          interactiveRpcSocket = socket
        } else {
          interactiveRpcSocket = socket
        }
      }
      return socket
    }

    override fun close() = Unit
  }

  private class FakeSocket : PiDaemonSocket {
    private val frames = Channel<String>(Channel.UNLIMITED)
    val sent = mutableListOf<String>()
    var failSend: Boolean = false
    var closed: Boolean = false
      private set

    override val incomingText: Flow<String> = frames.receiveAsFlow()

    fun push(text: String) {
      check(frames.trySend(text).isSuccess)
    }

    fun disconnect() {
      closed = true
      frames.close()
    }

    override suspend fun sendText(text: String) {
      check(!closed)
      if (failSend) throw IllegalStateException("https://secret.example/private send response")
      sent += text
    }

    override suspend fun close(
      code: Int,
      reason: String,
    ) {
      disconnect()
    }
  }

  private companion object {
    val repositoryRoot: Path = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  }
}
