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
  fun `metadata edit preserves credential and rejects another hosts endpoint`() =
    runTest {
      val store = FakeNoBackupCredentialStore()
      val vault = HostCredentialVault(FakeCredentialProtector(), store)
      val registry = HostRegistry(FakeHostRegistryStore(), vault, SequenceHostIdGenerator())
      val first =
        registry.register(
          PairingPayload.create(
            apiUri = URI("https://first.example.test"),
            displayName = "First",
            bearer = "first-bearer".toCharArray(),
          ),
        )
      val second =
        registry.register(
          PairingPayload.create(
            apiUri = URI("https://second.example.test"),
            displayName = "Second",
            bearer = "second-bearer".toCharArray(),
          ),
        )

      val edited =
        registry.updateMetadata(
          hostId = first.id,
          apiUri = URI("https://renamed.example.test/"),
          displayName = "Renamed",
          tlsFingerprint = null,
        )

      assertEquals(first.credential, edited.credential)
      assertEquals(first.bearerGeneration, edited.bearerGeneration)
      assertEquals("Renamed", edited.displayName)
      assertEquals(URI("https://renamed.example.test/"), edited.baseUri)
      assertEquals("first-bearer", vault.withBearer(edited.credential) { it.concatToString() })
      val duplicate =
        runCatching {
          registry.updateMetadata(first.id, second.baseUri, "Collision", null)
        }.exceptionOrNull()
      assertTrue(duplicate is IllegalArgumentException)
      assertEquals("Renamed", registry.list().single { it.id == first.id }.displayName)
    }

  @Test
  fun `failed replacement rolls back staged credential and preserves committed authority`() =
    runTest {
      val credentialStore = FakeNoBackupCredentialStore()
      val protector = FakeCredentialProtector()
      val vault = HostCredentialVault(protector, credentialStore)
      val metadataStore = FakeHostRegistryStore()
      val registry = HostRegistry(metadataStore, vault, SequenceHostIdGenerator())
      val original =
        registry.register(
          PairingPayload.create(
            apiUri = URI("https://workstation.example.test"),
            displayName = "Workstation",
            bearer = "old-bearer".toCharArray(),
          ),
        )
      metadataStore.failNextUpsert = true
      val replacement =
        PairingPayload.create(
          apiUri = URI("https://replacement.example.test"),
          displayName = "Replacement",
          bearer = "new-bearer".toCharArray(),
        )

      val failure = runCatching { registry.replace(original.id, replacement) }.exceptionOrNull()

      assertTrue(failure is IllegalStateException)
      assertEquals(original, registry.list().single())
      assertEquals("old-bearer", vault.withBearer(original.credential) { it.concatToString() })
      val staged = CredentialHandle(original.id, original.bearerGeneration + 1)
      assertEquals(null, credentialStore.read(staged))
      assertTrue(staged in protector.destroyed)
      assertThrows(IllegalStateException::class.java) { replacement.useBearer { it.concatToString() } }
    }

  @Test
  fun `failed credential persistence destroys its staged authority before metadata commit`() =
    runTest {
      val credentialStore = FakeNoBackupCredentialStore()
      val protector = FakeCredentialProtector()
      val vault = HostCredentialVault(protector, credentialStore)
      val metadataStore = FakeHostRegistryStore()
      val registry = HostRegistry(metadataStore, vault, SequenceHostIdGenerator())
      val original =
        registry.register(
          PairingPayload.create(
            apiUri = URI("https://workstation.example.test"),
            displayName = "Workstation",
            bearer = "old-bearer".toCharArray(),
          ),
        )
      credentialStore.failNextWrite = true

      val failure =
        runCatching {
          registry.replace(
            original.id,
            PairingPayload.create(
              URI("https://replacement.example.test"),
              "Replacement",
              "new-bearer".toCharArray(),
            ),
          )
        }.exceptionOrNull()

      val staged = CredentialHandle(original.id, 1)
      assertTrue(failure is IllegalStateException)
      assertTrue(staged in protector.destroyed)
      assertEquals(null, credentialStore.read(staged))
      assertEquals(original, registry.list().single())
      assertEquals("old-bearer", vault.withBearer(original.credential) { it.concatToString() })
    }

  @Test
  fun `new registry instance restores multiple hosts while forget failure preserves authority`() =
    runTest {
      val credentialStore = FakeNoBackupCredentialStore()
      val vault = HostCredentialVault(FakeCredentialProtector(), credentialStore)
      val metadataStore = FakeHostRegistryStore()
      val firstProcess = HostRegistry(metadataStore, vault, SequenceHostIdGenerator())
      val first =
        firstProcess.register(
          PairingPayload.create(URI("https://first.example.test"), "First", "first-secret".toCharArray()),
        )
      val second =
        firstProcess.register(
          PairingPayload.create(URI("https://second.example.test"), "Second", "second-secret".toCharArray()),
        )

      val afterProcessDeath = HostRegistry(metadataStore, vault, SequenceHostIdGenerator())
      assertEquals(listOf(first.id, second.id), afterProcessDeath.list().map { it.id })
      assertEquals("first-secret", vault.withBearer(first.credential) { it.concatToString() })
      assertEquals("second-secret", vault.withBearer(second.credential) { it.concatToString() })

      metadataStore.failNextRemove = true
      val failure = runCatching { afterProcessDeath.remove(first.id) }.exceptionOrNull()
      assertTrue(failure is IllegalStateException)
      assertEquals(listOf(first.id, second.id), afterProcessDeath.list().map { it.id })
      assertEquals("first-secret", vault.withBearer(first.credential) { it.concatToString() })
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
    var failNextUpsert: Boolean = false
    var failNextRemove: Boolean = false

    override suspend fun list(): List<RegisteredHost> = records.values.toList()

    override suspend fun upsert(host: RegisteredHost) {
      if (failNextUpsert) {
        failNextUpsert = false
        throw IllegalStateException("metadata commit failed")
      }
      records[host.id] = host
    }

    override suspend fun remove(hostId: HostId) {
      if (failNextRemove) {
        failNextRemove = false
        throw IllegalStateException("metadata removal failed")
      }
      records.remove(hostId)
    }
  }

  private class FakeNoBackupCredentialStore : NoBackupCredentialStore {
    override val storageClass: CredentialStorageClass = CredentialStorageClass.NO_BACKUP
    private val values = linkedMapOf<CredentialHandle, ProtectedCredential>()
    var failNextWrite: Boolean = false

    override suspend fun write(
      handle: CredentialHandle,
      credential: ProtectedCredential,
    ) {
      if (failNextWrite) {
        failNextWrite = false
        throw IllegalStateException("credential write failed")
      }
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
