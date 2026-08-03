package com.harryaskham.pidroid.sdk.core

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI

class PairingRegistryContractTest {
  @Test
  fun `stable ASCII QR payload is versioned bounded deterministic and redacted`() {
    val secret = "stable-service-bearer"
    val callerOwned = secret.toCharArray()
    val payload =
      PairingPayload.create(
        apiUri = URI("https://workstation.example.test"),
        displayName = "Workstation",
        bearer = callerOwned,
        tlsFingerprint = "FA:58:80:A7:C9:6D:F8:7B:B4:63:7D:18:58:7E:32:F6:CD:F6:95:06:52:34:FE:54:95:E2:4F:ED:12:1E:CE:4C",
      )
    callerOwned.fill('x')

    val encoded = PairingPayloadCodec.encode(payload)
    val decoded = PairingPayloadCodec.decode(encoded)

    assertTrue(encoded.all(Char::isAscii))
    assertTrue(encoded.startsWith("pidroid://pair/v1/"))
    assertEquals(encoded, PairingPayloadCodec.encode(decoded))
    assertEquals(URI("https://workstation.example.test"), decoded.apiUri)
    assertEquals("Workstation", decoded.displayName)
    assertEquals(secret, decoded.useBearer { it.concatToString() })
    assertFalse(payload.toString().contains(secret))
    assertFalse(decoded.toString().contains(secret))

    val malformedSecret = "must-not-reach-errors"
    val malformed =
      assertThrows(PairingPayloadException::class.java) {
        PairingPayloadCodec.decode("pidroid://pair/v2/$malformedSecret")
      }
    assertFalse(malformed.message.orEmpty().contains(malformedSecret))
    assertThrows(IllegalArgumentException::class.java) {
      PairingPayload.create(
        apiUri = URI("https://workstation.example.test"),
        displayName = "x".repeat(129),
        bearer = secret.toCharArray(),
      )
    }
  }

  @Test
  fun `registry consumes bearer into no-backup credential abstraction without secret models`() =
    runTest {
      val secret = "registry-service-bearer"
      val credentialStore = FakeNoBackupCredentialStore()
      val protector = FakeCredentialProtector()
      val vault = HostCredentialVault(protector, credentialStore)
      val metadataStore = FakeHostRegistryStore()
      val registry = HostRegistry(metadataStore, vault, SequenceHostIdGenerator())
      val payload =
        PairingPayload.create(
          apiUri = URI("https://workstation.example.test"),
          displayName = "Workstation",
          bearer = secret.toCharArray(),
        )

      val registered = registry.register(payload)

      assertEquals(HostId("host-1"), registered.id)
      assertEquals(0, registered.bearerGeneration)
      assertEquals(CredentialStorageClass.NO_BACKUP, credentialStore.storageClass)
      assertEquals(secret, vault.withBearer(registered.credential) { it.concatToString() })
      assertFalse(registered.toString().contains(secret))
      assertFalse(registered.credential.toString().contains(secret))
      assertFalse(credentialStore.toString().contains(secret))
      assertFalse(protector.toString().contains(secret))
      assertThrows(IllegalStateException::class.java) {
        payload.useBearer { it.concatToString() }
      }
    }

  @Test
  fun `bearer rotation changes cache identity and destroys the old credential`() =
    runTest {
      val store = FakeNoBackupCredentialStore()
      val protector = FakeCredentialProtector()
      val vault = HostCredentialVault(protector, store)
      val registry = HostRegistry(FakeHostRegistryStore(), vault, SequenceHostIdGenerator())
      val host =
        registry.register(
          PairingPayload.create(
            apiUri = URI("https://workstation.example.test"),
            displayName = "Workstation",
            bearer = "old-bearer".toCharArray(),
          ),
        )

      val rotated = registry.rotateBearer(host.id, "new-bearer".toCharArray())

      assertEquals(1, rotated.bearerGeneration)
      assertNotEquals(host.credential, rotated.credential)
      assertTrue(host.credential in protector.destroyed)
      assertEquals(null, store.read(host.credential))
      assertEquals("new-bearer", vault.withBearer(rotated.credential) { it.concatToString() })
    }

  @Test
  fun `remote plaintext registration requires explicit confirmation`() =
    runTest {
      val registry =
        HostRegistry(
          FakeHostRegistryStore(),
          HostCredentialVault(FakeCredentialProtector(), FakeNoBackupCredentialStore()),
          SequenceHostIdGenerator(),
        )
      val rejected =
        PairingPayload.create(
          apiUri = URI("http://workstation.tailnet.test:7463"),
          displayName = "Workstation",
          bearer = "bearer".toCharArray(),
        )

      val rejection = runCatching { registry.register(rejected, confirmInsecureHttp = false) }.exceptionOrNull()
      assertTrue(rejection is IllegalArgumentException)

      val confirmed =
        registry.register(
          PairingPayload.create(
            apiUri = URI("http://workstation.tailnet.test:7463"),
            displayName = "Workstation",
            bearer = "bearer".toCharArray(),
          ),
          confirmInsecureHttp = true,
        )
      assertEquals(TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT, confirmed.transportSecurity)
    }

  private class SequenceHostIdGenerator : HostIdGenerator {
    private var next = 1

    override fun next(): HostId = HostId("host-${next++}")
  }

  private class FakeHostRegistryStore : HostRegistryStore {
    private val records = linkedMapOf<HostId, RegisteredHost>()

    override suspend fun list(): List<RegisteredHost> = records.values.toList()

    override suspend fun upsert(host: RegisteredHost) {
      records[host.id] = host
    }

    override suspend fun remove(hostId: HostId) {
      records.remove(hostId)
    }
  }

  private class FakeNoBackupCredentialStore : NoBackupCredentialStore {
    override val storageClass: CredentialStorageClass = CredentialStorageClass.NO_BACKUP
    private val values = linkedMapOf<CredentialHandle, ProtectedCredential>()

    override suspend fun write(
      handle: CredentialHandle,
      credential: ProtectedCredential,
    ) {
      values[handle] = credential
    }

    override suspend fun read(handle: CredentialHandle): ProtectedCredential? = values[handle]

    override suspend fun remove(handle: CredentialHandle) {
      values.remove(handle)
    }

    override fun toString(): String = "FakeNoBackupCredentialStore(entries=${values.size}, content=[REDACTED])"
  }

  private class FakeCredentialProtector : CredentialProtector {
    val destroyed = linkedSetOf<CredentialHandle>()

    override suspend fun protect(
      handle: CredentialHandle,
      bearer: CharArray,
    ): ProtectedCredential = ProtectedCredential.fromBytes(bearer.concatToString().encodeToByteArray())

    override suspend fun reveal(
      handle: CredentialHandle,
      credential: ProtectedCredential,
    ): CharArray = credential.copyBytes().decodeToString().toCharArray()

    override suspend fun destroy(handle: CredentialHandle) {
      destroyed += handle
    }

    override fun toString(): String = "FakeCredentialProtector(content=[REDACTED])"
  }
}

private fun Char.isAscii(): Boolean = code in 0x20..0x7E
