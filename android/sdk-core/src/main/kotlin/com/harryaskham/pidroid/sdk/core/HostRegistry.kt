package com.harryaskham.pidroid.sdk.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.URI

public data class RegisteredHost(
  public val id: HostId,
  public val displayName: String,
  public val baseUri: URI,
  public val tlsFingerprint: String?,
  public val transportSecurity: TransportSecurity,
  public val bearerGeneration: Int,
  public val credential: CredentialHandle,
) {
  init {
    require(credential.hostId == id && credential.bearerGeneration == bearerGeneration) {
      "credential handle must match host bearer generation"
    }
  }

  override fun toString(): String =
    "RegisteredHost(id=${id.value}, displayName=$displayName, baseUri=$baseUri, tlsFingerprint=${tlsFingerprint != null}, transportSecurity=$transportSecurity, bearerGeneration=$bearerGeneration, credential=[OPAQUE])"
}

public fun interface HostIdGenerator {
  public fun next(): HostId
}

public interface HostRegistryStore {
  public suspend fun list(): List<RegisteredHost>

  public suspend fun upsert(host: RegisteredHost)

  public suspend fun remove(hostId: HostId)
}

/**
 * Metadata-only trusted-tailnet registry. Pairing payloads are consumed and closed during
 * registration; only an opaque [CredentialHandle] reaches registry records. Production storage may
 * use Room/DataStore later, but sdk-core depends only on this bounded injected contract.
 */
public class HostRegistry(
  private val store: HostRegistryStore,
  private val credentials: HostCredentialVault,
  private val ids: HostIdGenerator,
) {
  private val mutex = Mutex()

  public suspend fun list(): List<RegisteredHost> =
    mutex.withLock {
      store.list().sortedBy { it.id.value }
    }

  public suspend fun register(
    payload: PairingPayload,
    confirmInsecureHttp: Boolean = false,
  ): RegisteredHost =
    mutex.withLock {
      try {
        require(
          payload.transportSecurity != TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT ||
            confirmInsecureHttp,
        ) {
          "remote plaintext registration requires explicit confirmation"
        }
        val existing = store.list()
        require(existing.none { it.baseUri == payload.apiUri }) { "host endpoint is already registered" }
        val hostId = ids.next()
        require(existing.none { it.id == hostId }) { "host ID generator returned a duplicate identifier" }
        val handle = CredentialHandle(hostId, bearerGeneration = 0)
        payload.useBearerSuspending { bearer -> credentials.put(handle, bearer) }
        val registered =
          RegisteredHost(
            id = hostId,
            displayName = payload.displayName,
            baseUri = payload.apiUri,
            tlsFingerprint = payload.tlsFingerprint,
            transportSecurity = payload.transportSecurity,
            bearerGeneration = 0,
            credential = handle,
          )
        try {
          store.upsert(registered)
        } catch (error: Exception) {
          credentials.remove(handle)
          throw error
        }
        return@withLock registered
      } finally {
        payload.close()
      }
    }

  /** Updates only non-secret host metadata and preserves the current credential authority. */
  public suspend fun updateMetadata(
    hostId: HostId,
    apiUri: URI,
    displayName: String,
    tlsFingerprint: String?,
    confirmInsecureHttp: Boolean = false,
  ): RegisteredHost =
    mutex.withLock {
      val hosts = store.list()
      val current =
        hosts.singleOrNull { it.id == hostId }
          ?: throw IllegalArgumentException("host is not registered")
      val metadata = validateHostMetadata(apiUri, displayName, tlsFingerprint)
      require(
        metadata.transportSecurity != TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT || confirmInsecureHttp,
      ) {
        "remote plaintext registration requires explicit confirmation"
      }
      require(hosts.none { it.id != hostId && it.baseUri == metadata.apiUri }) {
        "host endpoint is already registered"
      }
      val updated =
        current.copy(
          displayName = metadata.displayName,
          baseUri = metadata.apiUri,
          tlsFingerprint = metadata.tlsFingerprint,
          transportSecurity = metadata.transportSecurity,
        )
      store.upsert(updated)
      updated
    }

  /**
   * Atomically commits replacement metadata and a new opaque credential generation. The old
   * credential remains authoritative until the metadata store accepts the replacement; a failed
   * commit destroys the staged generation and leaves the current host untouched.
   */
  public suspend fun replace(
    hostId: HostId,
    payload: PairingPayload,
    confirmInsecureHttp: Boolean = false,
  ): RegisteredHost =
    mutex.withLock {
      replaceLocked(hostId, payload, confirmInsecureHttp)
    }

  public suspend fun rotateBearer(
    hostId: HostId,
    bearer: CharArray,
  ): RegisteredHost =
    mutex.withLock {
      val current =
        store.list().singleOrNull { it.id == hostId }
          ?: throw IllegalArgumentException("host is not registered")
      replaceLocked(
        hostId = hostId,
        payload = PairingPayload.create(current.baseUri, current.displayName, bearer, current.tlsFingerprint),
        confirmInsecureHttp = current.transportSecurity == TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT,
      )
    }

  private suspend fun replaceLocked(
    hostId: HostId,
    payload: PairingPayload,
    confirmInsecureHttp: Boolean,
  ): RegisteredHost =
    try {
      require(
        payload.transportSecurity != TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT || confirmInsecureHttp,
      ) {
        "remote plaintext registration requires explicit confirmation"
      }
      val hosts = store.list()
      val current =
        hosts.singleOrNull { it.id == hostId }
          ?: throw IllegalArgumentException("host is not registered")
      require(hosts.none { it.id != hostId && it.baseUri == payload.apiUri }) {
        "host endpoint is already registered"
      }
      check(current.bearerGeneration < Int.MAX_VALUE) { "bearer generation is exhausted" }
      val nextHandle = CredentialHandle(hostId, current.bearerGeneration + 1)
      payload.useBearerSuspending { bearer -> credentials.put(nextHandle, bearer) }
      val replacement =
        RegisteredHost(
          id = hostId,
          displayName = payload.displayName,
          baseUri = payload.apiUri,
          tlsFingerprint = payload.tlsFingerprint,
          transportSecurity = payload.transportSecurity,
          bearerGeneration = nextHandle.bearerGeneration,
          credential = nextHandle,
        )
      try {
        store.upsert(replacement)
      } catch (error: Exception) {
        credentials.remove(nextHandle)
        throw error
      }
      credentials.remove(current.credential)
      replacement
    } finally {
      payload.close()
    }

  public suspend fun remove(hostId: HostId): Unit =
    mutex.withLock {
      val current = store.list().singleOrNull { it.id == hostId } ?: return@withLock
      // Metadata removal is the authority commit. A store failure must not strand a live record
      // whose credential has already been destroyed.
      store.remove(hostId)
      credentials.remove(current.credential)
    }

  override fun toString(): String = "HostRegistry(metadataOnly=true, credentials=[OPAQUE])"
}
