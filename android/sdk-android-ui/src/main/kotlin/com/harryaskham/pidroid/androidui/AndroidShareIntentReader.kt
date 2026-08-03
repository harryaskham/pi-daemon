package com.harryaskham.pidroid.androidui

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.util.UUID

public fun interface ShareStagingKeyFactory {
  public fun next(): String
}

public class ShareImportBatch internal constructor(
  public val text: ShareTextAdmission?,
  images: List<StagedShareImage>,
) {
  public val images: List<StagedShareImage> = images.toList()

  init {
    require(text != null || this.images.isNotEmpty()) { "share batch cannot be empty" }
    require(this.images.size <= AndroidUiManifestContract.MAX_IMAGE_ITEMS) { "share image count exceeds bound" }
  }

  override fun toString(): String = "ShareImportBatch(text=${text?.kind}, images=${images.size}, content=[REDACTED])"
}

/** Consumes Android URI grants synchronously; returned records contain no provider URI. */
public class AndroidShareIntentReader(
  context: Context,
  private val importer: ShareMvpImporter,
  private val keyFactory: ShareStagingKeyFactory = ShareStagingKeyFactory { "share-${UUID.randomUUID()}" },
) {
  private val resolver: ContentResolver = context.applicationContext.contentResolver

  public fun read(
    intent: Intent,
    nowMillis: Long,
  ): ShareImportBatch {
    require(intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
      "unsupported Android Share action"
    }
    val admittedText =
      intent
        .getCharSequenceExtra(Intent.EXTRA_TEXT)
        ?.toString()
        ?.takeIf(String::isNotBlank)
        ?.let(importer::admitText)
    val uris = imageUris(intent)
    if (uris.size > AndroidUiManifestContract.MAX_IMAGE_ITEMS) {
      throw ShareRejectedException(ShareRejectReason.SOURCE_TOO_LARGE)
    }
    val staged = mutableListOf<StagedShareImage>()
    try {
      uris.forEach { uri ->
        val mimeType = resolver.getType(uri) ?: intent.type.orEmpty()
        val stream = resolver.openInputStream(uri) ?: throw ShareRejectedException(ShareRejectReason.INVALID_SOURCE)
        staged +=
          importer.stageImage(
            stagingKey = keyFactory.next(),
            source = stream,
            sourceGrantUri = uri.toString(),
            mimeType = mimeType,
            displayName = displayName(uri),
            nowMillis = nowMillis,
          )
      }
      return ShareImportBatch(admittedText, staged)
    } catch (error: Throwable) {
      staged.forEach(importer::cancel)
      throw error
    }
  }

  private fun imageUris(intent: Intent): List<Uri> {
    val uris = linkedSetOf<Uri>()
    intent.clipData?.let { clip ->
      repeat(clip.itemCount) { index -> clip.getItemAt(index).uri?.let(uris::add) }
    }
    @Suppress("DEPRECATION")
    when (intent.action) {
      Intent.ACTION_SEND -> {
        (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)?.let(uris::add)
      }

      Intent.ACTION_SEND_MULTIPLE -> {
        intent
          .getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
          .orEmpty()
          .forEach(uris::add)
      }
    }
    return uris.toList()
  }

  private fun displayName(uri: Uri): String {
    val queried =
      runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
      }.getOrNull()
    return queried?.takeIf(String::isNotBlank) ?: "shared-image"
  }
}
