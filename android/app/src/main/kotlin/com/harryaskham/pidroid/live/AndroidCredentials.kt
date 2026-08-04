package com.harryaskham.pidroid.live

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.harryaskham.pidroid.sdk.core.CredentialHandle
import com.harryaskham.pidroid.sdk.core.CredentialProtector
import com.harryaskham.pidroid.sdk.core.CredentialStorageClass
import com.harryaskham.pidroid.sdk.core.NoBackupCredentialStore
import com.harryaskham.pidroid.sdk.core.ProtectedCredential
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

public class AndroidKeystoreCredentialProtector : CredentialProtector {
  private val keyStore = KeyStore.getInstance(KEY_STORE).apply { load(null) }

  override suspend fun protect(
    handle: CredentialHandle,
    bearer: CharArray,
  ): ProtectedCredential {
    val key = key(handle, create = true)
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val plaintext = bearer.concatToString().encodeToByteArray()
    return try {
      val encrypted = cipher.doFinal(plaintext)
      val encoded =
        ByteBuffer
          .allocate(2 + cipher.iv.size + encrypted.size)
          .put(VERSION)
          .put(cipher.iv.size.toByte())
          .put(cipher.iv)
          .put(encrypted)
          .array()
      ProtectedCredential.fromBytes(encoded)
    } finally {
      plaintext.fill(0)
    }
  }

  override suspend fun reveal(
    handle: CredentialHandle,
    credential: ProtectedCredential,
  ): CharArray {
    val encoded = credential.copyBytes()
    try {
      val buffer = ByteBuffer.wrap(encoded)
      require(buffer.get() == VERSION) { "protected credential version is unsupported" }
      val ivSize = buffer.get().toInt() and 0xff
      require(ivSize in 12..32 && buffer.remaining() > ivSize) { "protected credential is corrupt" }
      val iv = ByteArray(ivSize).also(buffer::get)
      val ciphertext = ByteArray(buffer.remaining()).also(buffer::get)
      val cipher = Cipher.getInstance(CIPHER)
      cipher.init(Cipher.DECRYPT_MODE, key(handle, create = false), GCMParameterSpec(128, iv))
      val plaintext = cipher.doFinal(ciphertext)
      return try {
        plaintext.decodeToString(throwOnInvalidSequence = true).toCharArray()
      } finally {
        plaintext.fill(0)
        iv.fill(0)
        ciphertext.fill(0)
      }
    } finally {
      encoded.fill(0)
    }
  }

  override suspend fun destroy(handle: CredentialHandle) {
    synchronized(keyStore) { keyStore.deleteEntry(alias(handle)) }
  }

  private fun key(
    handle: CredentialHandle,
    create: Boolean,
  ): SecretKey =
    synchronized(keyStore) {
      (keyStore.getKey(alias(handle), null) as? SecretKey)
        ?: if (create) {
          val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE)
          generator.init(
            KeyGenParameterSpec
              .Builder(
                alias(handle),
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
              ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setRandomizedEncryptionRequired(true)
              .setUserAuthenticationRequired(false)
              .build(),
          )
          generator.generateKey()
        } else {
          error("credential Keystore key is not available")
        }
    }

  private fun alias(handle: CredentialHandle): String {
    val identity = "${handle.hostId.value}:${handle.bearerGeneration}".encodeToByteArray()
    val digest = MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) }
    identity.fill(0)
    return "pi-droid-host-$digest"
  }

  private companion object {
    const val KEY_STORE: String = "AndroidKeyStore"
    const val CIPHER: String = "AES/GCM/NoPadding"
    const val VERSION: Byte = 1
  }
}

public class FileNoBackupCredentialStore(
  context: Context,
) : NoBackupCredentialStore {
  override val storageClass: CredentialStorageClass = CredentialStorageClass.NO_BACKUP
  private val root =
    context.noBackupFilesDir.resolve("host-credentials").also { directory ->
      require(directory.mkdirs() || directory.isDirectory) { "could not create no-backup credential directory" }
    }

  override suspend fun write(
    handle: CredentialHandle,
    credential: ProtectedCredential,
  ) {
    val target = file(handle).toPath()
    val temporary = Files.createTempFile(root.toPath(), ".credential-", ".tmp")
    val bytes = credential.copyBytes()
    try {
      Files.write(temporary, bytes)
      try {
        Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
      } catch (_: UnsupportedOperationException) {
        Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
      }
    } finally {
      bytes.fill(0)
      Files.deleteIfExists(temporary)
    }
  }

  override suspend fun read(handle: CredentialHandle): ProtectedCredential? {
    val target = file(handle)
    if (!target.isFile) return null
    val bytes = target.readBytes()
    return try {
      ProtectedCredential.fromBytes(bytes)
    } finally {
      bytes.fill(0)
    }
  }

  override suspend fun remove(handle: CredentialHandle) {
    Files.deleteIfExists(file(handle).toPath())
  }

  private fun file(handle: CredentialHandle) = root.resolve("${safe(handle.hostId.value)}-${handle.bearerGeneration}.bin")

  private fun safe(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.encodeToByteArray()).joinToString("") { "%02x".format(it) }
}
