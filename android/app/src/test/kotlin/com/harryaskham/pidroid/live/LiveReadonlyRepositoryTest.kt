package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.CredentialHandle
import com.harryaskham.pidroid.sdk.core.CredentialProtector
import com.harryaskham.pidroid.sdk.core.CredentialStorageClass
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HostRegistryStore
import com.harryaskham.pidroid.sdk.core.NeutralHeaders
import com.harryaskham.pidroid.sdk.core.NeutralHttpRequest
import com.harryaskham.pidroid.sdk.core.NeutralHttpResponse
import com.harryaskham.pidroid.sdk.core.NeutralWebSocketRequest
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.PiDaemonSocket
import com.harryaskham.pidroid.sdk.core.ProtectedCredential
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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
    var authorizationObserved: Boolean = false
    val paths = mutableListOf<String>()

    override fun replaceHosts(hosts: List<RegisteredHost>) = Unit

    override suspend fun execute(
      host: HostId,
      request: NeutralHttpRequest,
    ): NeutralHttpResponse {
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
      var frame = repositoryRoot.resolve("fixtures/session-api/rpc.ready.frame.json").toFile().readText()
      frame =
        frame
          .replace("host-01", hostInstanceId)
          .replace("agent-a", "session-fixture-01")
      return object : PiDaemonSocket {
        override val incomingText: Flow<String> = flowOf(frame)

        override suspend fun sendText(text: String) = error("readonly socket must not send")

        override suspend fun close(
          code: Int,
          reason: String,
        ) = Unit
      }
    }

    override fun close() = Unit
  }

  private companion object {
    val repositoryRoot: Path = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  }
}
