package com.harryaskham.pidroid.sdk.core

public enum class CredentialStorageClass {
  NO_BACKUP,
}

public data class CredentialHandle(
  public val hostId: HostId,
  public val bearerGeneration: Int,
) {
  init {
    require(bearerGeneration >= 0) { "bearer generation must be non-negative" }
  }
}

/** Opaque protected bearer ciphertext. This is not a key or plaintext model. */
public class ProtectedCredential private constructor(
  bytes: ByteArray,
) {
  private val bytes: ByteArray = bytes.copyOf()

  public fun copyBytes(): ByteArray = bytes.copyOf()

  override fun toString(): String = "ProtectedCredential(bytes=${bytes.size}, content=[REDACTED])"

  public companion object {
    public fun fromBytes(bytes: ByteArray): ProtectedCredential {
      require(bytes.isNotEmpty() && bytes.size <= 32_768) { "protected credential is missing or too large" }
      return ProtectedCredential(bytes)
    }
  }
}

/**
 * Android production implementations seal with a non-exportable Keystore key bound to [handle].
 * Test fakes may use reversible bytes, but key/plaintext material must never enter models or logs.
 */
public interface CredentialProtector {
  public suspend fun protect(
    handle: CredentialHandle,
    bearer: CharArray,
  ): ProtectedCredential

  public suspend fun reveal(
    handle: CredentialHandle,
    credential: ProtectedCredential,
  ): CharArray

  public suspend fun destroy(handle: CredentialHandle)
}

/**
 * Ciphertext backend whose Android implementation must live below `noBackupFilesDir` and be excluded
 * from device backup. It stores no plaintext and no Keystore key bytes.
 */
public interface NoBackupCredentialStore {
  public val storageClass: CredentialStorageClass

  public suspend fun write(
    handle: CredentialHandle,
    credential: ProtectedCredential,
  )

  public suspend fun read(handle: CredentialHandle): ProtectedCredential?

  public suspend fun remove(handle: CredentialHandle)
}

public class HostCredentialVault(
  private val protector: CredentialProtector,
  private val store: NoBackupCredentialStore,
) {
  init {
    require(store.storageClass == CredentialStorageClass.NO_BACKUP) {
      "credential backend must guarantee no-backup storage"
    }
  }

  public suspend fun put(
    handle: CredentialHandle,
    bearer: CharArray,
  ) {
    require(bearer.isNotEmpty() && bearer.size <= 4_096) { "service bearer is missing or too long" }
    require(bearer.none { it == '\r' || it == '\n' || it == '\u0000' }) {
      "service bearer contains an invalid character"
    }
    val temporary = bearer.copyOf()
    try {
      val protected = protector.protect(handle, temporary)
      store.write(handle, protected)
    } finally {
      temporary.fill('\u0000')
    }
  }

  public suspend fun <T> withBearer(
    handle: CredentialHandle,
    block: (CharArray) -> T,
  ): T {
    val protected =
      store.read(handle)
        ?: throw IllegalStateException("credential handle is not available")
    val bearer = protector.reveal(handle, protected)
    return try {
      require(
        bearer.isNotEmpty() && bearer.size <= 4_096 &&
          bearer.none { it == '\r' || it == '\n' || it == '\u0000' },
      ) { "revealed service bearer is invalid" }
      block(bearer)
    } finally {
      bearer.fill('\u0000')
    }
  }

  public suspend fun remove(handle: CredentialHandle) {
    store.remove(handle)
    protector.destroy(handle)
  }

  override fun toString(): String = "HostCredentialVault(storage=NO_BACKUP, content=[REDACTED])"
}
