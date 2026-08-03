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

  public suspend fun rotateBearer(
    hostId: HostId,
    bearer: CharArray,
  ): RegisteredHost =
    mutex.withLock {
      val current =
        store.list().singleOrNull { it.id == hostId }
          ?: throw IllegalArgumentException("host is not registered")
      check(current.bearerGeneration < Int.MAX_VALUE) { "bearer generation is exhausted" }
      val nextHandle = CredentialHandle(hostId, current.bearerGeneration + 1)
      credentials.put(nextHandle, bearer)
      val rotated =
        current.copy(
          bearerGeneration = nextHandle.bearerGeneration,
          credential = nextHandle,
        )
      try {
        store.upsert(rotated)
      } catch (error: Exception) {
        credentials.remove(nextHandle)
        throw error
      }
      credentials.remove(current.credential)
      return@withLock rotated
    }

  public suspend fun remove(hostId: HostId): Unit =
    mutex.withLock {
      val current = store.list().singleOrNull { it.id == hostId } ?: return@withLock
      credentials.remove(current.credential)
      store.remove(hostId)
    }

  override fun toString(): String = "HostRegistry(metadataOnly=true, credentials=[OPAQUE])"
}
