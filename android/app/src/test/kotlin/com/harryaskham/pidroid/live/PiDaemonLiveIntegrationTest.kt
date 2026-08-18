package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.CredentialHandle
import com.harryaskham.pidroid.sdk.core.CredentialProtector
import com.harryaskham.pidroid.sdk.core.CredentialStorageClass
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HostRegistryStore
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.NoBackupCredentialStore
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.ProtectedCredential
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.ServiceBearerRequestFactory
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.time.Duration
import java.util.concurrent.TimeUnit

class PiDaemonLiveIntegrationTest {
  private lateinit var tempDir: File
  private lateinit var readyFile: File
  private lateinit var tokenFile: File
  private lateinit var stateDir: File
  private var daemonProcess: Process? = null
  private val token = "pidroid-integration-test-token"
  private var port: Int = 0

  @BeforeEach
  fun setUp() {
    val ownerOnly =
      PosixFilePermissions.asFileAttribute(
        setOf(
          PosixFilePermission.OWNER_READ,
          PosixFilePermission.OWNER_WRITE,
          PosixFilePermission.OWNER_EXECUTE,
        ),
      )
    tempDir = Files.createTempDirectory("pidroid-live-e2e-", ownerOnly).toFile()
    readyFile = File(tempDir, "ready.json")
    tokenFile = File(tempDir, "token")
    stateDir = Files.createDirectory(tempDir.toPath().resolve("state"), ownerOnly).toFile()

    tokenFile.writeText("$token\n")
    Files.setPosixFilePermissions(
      tokenFile.toPath(),
      setOf(
        PosixFilePermission.OWNER_READ,
        PosixFilePermission.OWNER_WRITE,
      ),
    )

    val repoRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot"))).toFile()
    val nodePath = findNodeExecutable()

    val processBuilder =
      ProcessBuilder(
        nodePath,
        "scripts/pi-droid-disposable-daemon.mjs",
        "--port",
        "0",
        "--token-file",
        tokenFile.absolutePath,
        "--ready-file",
        readyFile.absolutePath,
        "--state-dir",
        stateDir.absolutePath,
        "--interactive",
      ).directory(repoRoot)
        .redirectError(ProcessBuilder.Redirect.INHERIT)

    daemonProcess = processBuilder.start()

    val deadline = System.currentTimeMillis() + 15_000
    while (System.currentTimeMillis() < deadline) {
      if (readyFile.exists() && readyFile.length() > 0) {
        break
      }
      Thread.sleep(50)
    }
    assertTrue(readyFile.exists(), "Daemon ready.json was not written in time")
    val readyJson = readyFile.readText()
    val portMatch = Regex("\"port\":\\s*(\\d+)").find(readyJson)
    assertNotNull(portMatch, "Daemon port not found in ready.json")
    port = portMatch!!.groupValues[1].toInt()
    assertTrue(port in 1024..65535, "Port must be valid positive int")
  }

  @AfterEach
  fun tearDown() {
    daemonProcess?.destroy()
    daemonProcess?.waitFor(5, TimeUnit.SECONDS)
    tempDir.deleteRecursively()
  }

  @Test
  fun testLiveClientEndToEndSessionFlowAgainstRealDaemon() =
    runTest {
      withContext(Dispatchers.Default.limitedParallelism(1)) {
        val transport = OkHttpPiDaemonTransport(webSocketPingInterval = Duration.ofSeconds(5))
        var hostIdCounter = 0

        val credentialVault =
          HostCredentialVault(
            protector =
              object : CredentialProtector {
                override suspend fun protect(
                  handle: CredentialHandle,
                  bearer: CharArray,
                ) = ProtectedCredential.fromBytes(bearer.concatToString().toByteArray())

                override suspend fun reveal(
                  handle: CredentialHandle,
                  credential: ProtectedCredential,
                ) = credential.copyBytes().decodeToString().toCharArray()

                override suspend fun destroy(handle: CredentialHandle) = Unit
              },
            store =
              object : NoBackupCredentialStore {
                override val storageClass = CredentialStorageClass.NO_BACKUP
                private val map = mutableMapOf<CredentialHandle, ProtectedCredential>()

                override suspend fun write(
                  handle: CredentialHandle,
                  credential: ProtectedCredential,
                ) {
                  map[handle] = credential
                }

                override suspend fun read(handle: CredentialHandle) = map[handle]

                override suspend fun remove(handle: CredentialHandle) {
                  map.remove(handle)
                }
              },
          )

        val hostRegistry =
          HostRegistry(
            store =
              object : HostRegistryStore {
                private val list = mutableListOf<RegisteredHost>()

                override suspend fun list() = list.toList()

                override suspend fun upsert(host: RegisteredHost) {
                  list.removeAll { it.id == host.id }
                  list.add(host)
                }

                override suspend fun remove(hostId: HostId) {
                  list.removeAll { it.id == hostId }
                }
              },
            credentials = credentialVault,
            ids = { HostId("test-live-daemon-${++hostIdCounter}") },
          )

        val defaultHostStore =
          object : DefaultHostStore {
            var current: HostId? = null

            override suspend fun read() = current

            override suspend fun write(hostId: HostId?) {
              current = hostId
            }
          }

        val dailyDriverStore =
          object : DailyDriverStore {
            val inventoryMap = mutableMapOf<HostId, String>()
            var resume: ByteArray? = null
            var bookmark: LiveSessionActionBookmark? = null

            override suspend fun readSelectedInventory(hostId: HostId) = inventoryMap[hostId]

            override suspend fun writeSelectedInventory(
              hostId: HostId,
              inventoryId: String?,
            ) {
              if (inventoryId == null) inventoryMap.remove(hostId) else inventoryMap[hostId] = inventoryId
            }

            override suspend fun readActionBookmark() = bookmark

            override suspend fun writeActionBookmark(bookmark: LiveSessionActionBookmark?) {
              this.bookmark = bookmark
            }

            override suspend fun readInteractiveResume() = resume

            override suspend fun writeInteractiveResume(encoded: ByteArray?) {
              resume = encoded
            }
          }

        val repository =
          LiveReadonlyRepository(
            registry = hostRegistry,
            credentials = credentialVault,
            transport = transport,
            defaultHostStore = defaultHostStore,
            dailyDriverStore = dailyDriverStore,
          )

        val baseUri = URI("http://127.0.0.1:$port")

        // Register daemon with repository
        repository.registerManual(
          apiUri = baseUri,
          displayName = "Live Test Daemon",
          bearer = token.toCharArray(),
          tlsFingerprint = null,
          confirmInsecureHttp = true,
        )

        // Verify repository reaches LiveReadonlyState.Ready
        val readyState =
          withTimeout(10_000) {
            repository.state.filterIsInstance<LiveReadonlyState.Ready>().first()
          }
        assertEquals(1, readyState.hosts.size)
        val hostSession = readyState.hosts.first()
        assertEquals(CacheFreshness.FRESH, hostSession.session?.host?.freshness)

        // Connect interactive session and verify observer attach + TUI
        repository.connectInteractiveObserver()
        val connectedObserver =
          withTimeout(10_000) {
            repository.interactiveState.filterIsInstance<LiveInteractiveAppState.Ready>().first()
          }
        assertEquals("session-fixture-01", connectedObserver.sessionId)
        assertEquals(InteractiveControllerRole.OBSERVER, connectedObserver.snapshot.role)

        // Request control
        repository.requestControl()
        val controllerState =
          withTimeout(10_000) {
            repository.interactiveState.filterIsInstance<LiveInteractiveAppState.Ready>().first {
              it.snapshot.role == InteractiveControllerRole.CONTROLLER
            }
          }
        assertEquals(InteractiveControllerRole.CONTROLLER, controllerState.snapshot.role)

        // Submit a prompt and observe roundtrip
        repository.handleInteraction(RichInteractionAction.SubmitPrompt("hello from e2e live integration test"))
        val promptResultState =
          withTimeout(10_000) {
            repository.interactiveState.filterIsInstance<LiveInteractiveAppState.Ready>().first {
              it.snapshot.receipts.isNotEmpty()
            }
          }
        assertTrue(promptResultState.snapshot.receipts.any { it.kind.wireValue == "prompt" }, "Command receipts should record prompt")

        // Release control
        repository.releaseControl()
        val releasedObserver =
          withTimeout(10_000) {
            repository.interactiveState.filterIsInstance<LiveInteractiveAppState.Ready>().first {
              it.snapshot.role == InteractiveControllerRole.OBSERVER
            }
          }
        assertEquals(InteractiveControllerRole.OBSERVER, releasedObserver.snapshot.role)

        repository.close()
        transport.close()
      }
    }

  private fun findNodeExecutable(): String {
    val path = System.getenv("PATH") ?: ""
    for (entry in path.split(File.pathSeparator)) {
      val file = File(entry, "node")
      if (file.canExecute()) return file.absolutePath
    }
    return "node"
  }
}
