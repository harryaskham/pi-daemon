package com.harryaskham.pidroid.androidui

import android.content.Context
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AES-GCM encrypted staging rooted strictly inside Context.noBackupFilesDir. */
public class NoBackupShareStagingStore(
  context: Context,
  private val key: SecretKey,
  private val random: SecureRandom = SecureRandom(),
) : ShareStagingStore {
  private val root: File = File(context.noBackupFilesDir, DIRECTORY_NAME).canonicalFile

  init {
    require(key.algorithm == "AES") { "share staging key must use AES" }
    check(root.isDirectory || root.mkdirs()) { "cannot create no-backup share staging" }
    require(root.toPath().startsWith(context.noBackupFilesDir.canonicalFile.toPath())) {
      "share staging escaped no-backup root"
    }
  }

  @Synchronized
  override fun open(stagingKey: String): OutputStream {
    require(stagingKey.isBoundedAndroidUiIdentifier()) { "share staging key is invalid" }
    val partial = file(stagingKey, PART_SUFFIX)
    check(!partial.exists() && !file(stagingKey, DATA_SUFFIX).exists()) { "share staging key already exists" }
    val iv = ByteArray(GCM_IV_BYTES).also(random::nextBytes)
    val cipher =
      Cipher.getInstance(CIPHER_TRANSFORMATION).apply {
        init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
      }
    val raw = FileOutputStream(partial)
    try {
      raw.write(MAGIC)
      raw.write(iv.size)
      raw.write(iv)
      return CipherOutputStream(raw, cipher)
    } catch (error: Throwable) {
      raw.close()
      partial.delete()
      throw error
    }
  }

  @Synchronized
  override fun commit(
    stagingKey: String,
    expiresAtMillis: Long,
  ) {
    require(expiresAtMillis > 0) { "share staging expiry is invalid" }
    val partial = file(stagingKey, PART_SUFFIX)
    val data = file(stagingKey, DATA_SUFFIX)
    check(partial.isFile && partial.renameTo(data)) { "cannot commit share staging" }
    val temporaryTtl = file(stagingKey, TTL_TEMP_SUFFIX)
    val ttl = file(stagingKey, TTL_SUFFIX)
    try {
      temporaryTtl.writeText(expiresAtMillis.toString(), StandardCharsets.US_ASCII)
      check(temporaryTtl.renameTo(ttl)) { "cannot commit share staging TTL" }
    } catch (error: Throwable) {
      temporaryTtl.delete()
      data.delete()
      throw error
    }
  }

  /** Opens one admitted image without exposing a filesystem path or provider URI. */
  @Synchronized
  public fun openImage(image: StagedShareImage): InputStream {
    val data = file(image.stagingKey, DATA_SUFFIX)
    val raw = FileInputStream(data)
    try {
      val magic = readExact(raw, MAGIC.size)
      require(magic.contentEquals(MAGIC)) { "share staging header is invalid" }
      val ivLength = raw.read()
      require(ivLength == GCM_IV_BYTES) { "share staging IV is invalid" }
      val iv = readExact(raw, ivLength)
      val cipher =
        Cipher.getInstance(CIPHER_TRANSFORMATION).apply {
          init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        }
      return CipherInputStream(raw, cipher)
    } catch (error: Throwable) {
      raw.close()
      throw error
    }
  }

  @Synchronized
  override fun discard(stagingKey: String) {
    if (!stagingKey.isBoundedAndroidUiIdentifier()) return
    listOf(PART_SUFFIX, DATA_SUFFIX, TTL_SUFFIX, TTL_TEMP_SUFFIX).forEach { suffix ->
      file(stagingKey, suffix).delete()
    }
  }

  @Synchronized
  override fun pruneExpired(nowMillis: Long): Int {
    require(nowMillis >= 0) { "share staging prune time is invalid" }
    root
      .listFiles()
      .orEmpty()
      .filter { it.name.endsWith(PART_SUFFIX) || it.name.endsWith(TTL_TEMP_SUFFIX) }
      .forEach(File::delete)
    var deleted = 0
    root.listFiles().orEmpty().filter { it.name.endsWith(DATA_SUFFIX) }.forEach { data ->
      val stagingKey = data.name.removeSuffix(DATA_SUFFIX)
      val ttl = file(stagingKey, TTL_SUFFIX)
      val expiresAt =
        ttl
          .takeIf(File::isFile)
          ?.let { runCatching { it.readText(StandardCharsets.US_ASCII).toLong() }.getOrNull() }
      if (expiresAt == null || expiresAt <= nowMillis) {
        if (data.delete()) deleted += 1
        ttl.delete()
      }
    }
    return deleted
  }

  private fun readExact(
    input: InputStream,
    size: Int,
  ): ByteArray {
    val bytes = ByteArray(size)
    var offset = 0
    while (offset < size) {
      val read = input.read(bytes, offset, size - offset)
      require(read > 0) { "share staging header is truncated" }
      offset += read
    }
    return bytes
  }

  private fun file(
    stagingKey: String,
    suffix: String,
  ): File {
    val candidate = File(root, stagingKey + suffix).canonicalFile
    require(candidate.parentFile == root) { "share staging path escaped root" }
    return candidate
  }

  private companion object {
    const val DIRECTORY_NAME: String = "pidroid-share-v1"
    const val PART_SUFFIX: String = ".part"
    const val DATA_SUFFIX: String = ".bin"
    const val TTL_SUFFIX: String = ".ttl"
    const val TTL_TEMP_SUFFIX: String = ".ttl.part"
    const val CIPHER_TRANSFORMATION: String = "AES/GCM/NoPadding"
    const val GCM_IV_BYTES: Int = 12
    const val GCM_TAG_BITS: Int = 128
    val MAGIC: ByteArray = byteArrayOf('P'.code.toByte(), 'D'.code.toByte(), 'S'.code.toByte(), 1)
  }
}
