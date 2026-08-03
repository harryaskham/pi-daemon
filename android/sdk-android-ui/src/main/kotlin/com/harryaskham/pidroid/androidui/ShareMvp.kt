package com.harryaskham.pidroid.androidui

import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest

public object AndroidUiManifestContract {
  public const val DEEP_LINK_SCHEME: String = "pidroid"
  public const val ACCEPTS_GENERIC_DOCUMENTS: Boolean = false
  public const val WIDGET_EXPORTED: Boolean = false
  public const val MAX_IMAGE_ITEMS: Int = 32
  public val SHARE_MIME_TYPES: Set<String> =
    setOf("text/plain", "image/png", "image/jpeg", "image/webp", "image/gif")
}

public interface ShareStagingStore {
  /** Opens encrypted no-backup staging for one opaque app-owned key. */
  public fun open(stagingKey: String): OutputStream

  public fun commit(
    stagingKey: String,
    expiresAtMillis: Long,
  )

  public fun discard(stagingKey: String)

  /** Deletes committed and partial entries whose durable TTL has elapsed after process recreation. */
  public fun pruneExpired(nowMillis: Long): Int
}

public enum class ShareRejectReason {
  EMPTY_TEXT,
  TEXT_TOO_LARGE,
  UNSUPPORTED_URI,
  UNSUPPORTED_MIME,
  INVALID_SOURCE,
  SOURCE_TOO_LARGE,
  ENCODED_IMAGE_TOO_LARGE,
  INVALID_NAME,
}

public class ShareRejectedException(
  public val reason: ShareRejectReason,
) : IllegalArgumentException("share input rejected: ${reason.name.lowercase()}")

public enum class ShareTextKind {
  TEXT,
  URL,
}

public class ShareTextAdmission internal constructor(
  public val text: String,
  public val kind: ShareTextKind,
) {
  override fun toString(): String = "ShareTextAdmission(kind=$kind, chars=${text.length}, content=[REDACTED])"
}

public class StagedShareImage internal constructor(
  public val stagingKey: String,
  public val mimeType: String,
  public val displayName: String,
  public val byteCount: Long,
  public val base64Bytes: Int,
  public val sha256: String,
  public val expiresAtMillis: Long,
) {
  override fun toString(): String =
    "StagedShareImage(stagingKey=$stagingKey, mimeType=$mimeType, bytes=$byteCount, base64Bytes=$base64Bytes, sha256=$sha256, expiresAtMillis=$expiresAtMillis, source=[REDACTED])"
}

/**
 * MVP Share importer for bounded text/URLs and images that fit Pi RPC and negotiated frame bounds.
 *
 * Provider URIs are used only while the caller owns the grant. This class retains no URI and
 * streams into an injected encrypted no-backup store while hashing and counting actual bytes.
 */
public class ShareMvpImporter(
  private val store: ShareStagingStore,
  public val maxSourceBytes: Int,
  public val maxEncodedBytes: Int,
  public val maxFrameBytes: Int,
  public val ttlMillis: Long,
  public val frameEnvelopeBytes: Int = 1_024,
  public val maxTextChars: Int = 65_536,
  public val copyBufferBytes: Int = 8_192,
) {
  init {
    require(maxSourceBytes in 1..MAX_PI_RPC_IMAGE_BYTES) { "share source bound is invalid" }
    require(maxEncodedBytes > 0) { "share encoded bound is invalid" }
    require(maxFrameBytes > 0) { "share frame bound is invalid" }
    require(frameEnvelopeBytes in 0 until maxFrameBytes) { "share frame envelope bound is invalid" }
    require(ttlMillis in 1..MAX_STAGING_TTL_MILLIS) { "share staging TTL is invalid" }
    require(maxTextChars in 1..1_048_576) { "share text bound is invalid" }
    require(copyBufferBytes in 1..65_536) { "share copy buffer bound is invalid" }
  }

  public fun admitText(text: String): ShareTextAdmission {
    if (text.isBlank()) throw ShareRejectedException(ShareRejectReason.EMPTY_TEXT)
    if (text.length > maxTextChars || '\u0000' in text) throw ShareRejectedException(ShareRejectReason.TEXT_TOO_LARGE)
    val uri = runCatching { URI(text) }.getOrNull()
    val kind =
      if (uri?.scheme == null) {
        ShareTextKind.TEXT
      } else {
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.userInfo != null) {
          throw ShareRejectedException(ShareRejectReason.UNSUPPORTED_URI)
        }
        ShareTextKind.URL
      }
    return ShareTextAdmission(text, kind)
  }

  public fun stageImage(
    stagingKey: String,
    source: InputStream,
    sourceGrantUri: String,
    mimeType: String,
    displayName: String,
    nowMillis: Long,
  ): StagedShareImage {
    if (!stagingKey.isBoundedAndroidUiIdentifier() || nowMillis < 0) {
      throw ShareRejectedException(ShareRejectReason.INVALID_SOURCE)
    }
    val sourceUri = runCatching { URI(sourceGrantUri) }.getOrNull()
    if (sourceUri?.scheme != "content" || sourceGrantUri.length > 2_048) {
      throw ShareRejectedException(ShareRejectReason.INVALID_SOURCE)
    }
    if (mimeType !in AndroidUiManifestContract.SHARE_MIME_TYPES || !mimeType.startsWith("image/")) {
      throw ShareRejectedException(ShareRejectReason.UNSUPPORTED_MIME)
    }
    val safeName = sanitizeDisplayName(displayName)
    val digest = MessageDigest.getInstance("SHA-256")
    var count = 0L
    try {
      store.open(stagingKey).use { output ->
        source.use { input ->
          val buffer = ByteArray(copyBufferBytes)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read == 0) continue
            count += read
            if (count > maxSourceBytes) throw ShareRejectedException(ShareRejectReason.SOURCE_TOO_LARGE)
            digest.update(buffer, 0, read)
            output.write(buffer, 0, read)
          }
        }
      }
      val encodedBytes = base64Size(count)
      if (encodedBytes > maxEncodedBytes || encodedBytes.toLong() + frameEnvelopeBytes > maxFrameBytes) {
        throw ShareRejectedException(ShareRejectReason.ENCODED_IMAGE_TOO_LARGE)
      }
      val expiresAt =
        try {
          Math.addExact(nowMillis, ttlMillis)
        } catch (_: ArithmeticException) {
          throw ShareRejectedException(ShareRejectReason.INVALID_SOURCE)
        }
      store.commit(stagingKey, expiresAt)
      return StagedShareImage(
        stagingKey = stagingKey,
        mimeType = mimeType,
        displayName = safeName,
        byteCount = count,
        base64Bytes = encodedBytes,
        sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) },
        expiresAtMillis = expiresAt,
      )
    } catch (error: Throwable) {
      store.discard(stagingKey)
      throw error
    }
  }

  public fun cancel(image: StagedShareImage) {
    store.discard(image.stagingKey)
  }

  public fun recoverAfterProcessDeath(nowMillis: Long): Int {
    require(nowMillis >= 0) { "share recovery time must be non-negative" }
    return store.pruneExpired(nowMillis)
  }

  private fun sanitizeDisplayName(displayName: String): String {
    val leaf = displayName.substringAfterLast('/').substringAfterLast('\\')
    val sanitized =
      leaf
        .filter { character -> character.isLetterOrDigit() || character in setOf('.', '-', '_', ' ') }
        .trim(' ', '.')
        .take(128)
    if (sanitized.isEmpty()) throw ShareRejectedException(ShareRejectReason.INVALID_NAME)
    return sanitized
  }

  private fun base64Size(bytes: Long): Int = (4L * ((bytes + 2L) / 3L)).toInt()

  private companion object {
    const val MAX_PI_RPC_IMAGE_BYTES: Int = 16 * 1_024 * 1_024
    const val MAX_STAGING_TTL_MILLIS: Long = 24 * 60 * 60 * 1_000L
  }
}
