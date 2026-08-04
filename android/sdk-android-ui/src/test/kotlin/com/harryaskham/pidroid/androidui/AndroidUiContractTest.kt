package com.harryaskham.pidroid.androidui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class AndroidUiContractTest {
  private val selection = SavedSessionSelection(HostId("workstation"), "session-01")

  @Test
  fun `widget selection survives recreation without credentials and stale state gates actions`() {
    val encoded = WidgetSelectionCodec.encode(WidgetSelection(selection, WidgetMode.INTERACTIVE))
    val recreated = WidgetSelectionCodec.decode(encoded)
    assertEquals(WidgetSelection(selection, WidgetMode.INTERACTIVE), recreated)
    assertFalse(encoded.contains("bearer", ignoreCase = true))
    assertFalse(encoded.contains("token", ignoreCase = true))

    val stale =
      WidgetProjectionPolicy.project(
        selection = recreated!!,
        hostLabel = "Workstation",
        sessionLabel = "Build monitor",
        freshness = CacheFreshness.FRESH,
        observedAtMillis = 1_000,
        nowMillis = 70_000,
        staleAfterMillis = 60_000,
        interactiveOptIn = true,
      )
    assertTrue(stale.stale)
    assertEquals("Stale · 1m", stale.freshnessLabel)
    assertEquals(WidgetActionDecision.REQUIRES_FRESH_REVALIDATION, stale.decide(WidgetAction.WAKE, revalidatedAtMillis = 70_000))
    assertEquals(WidgetActionDecision.OPEN_APP, stale.decide(WidgetAction.OPEN, revalidatedAtMillis = null))

    val fresh =
      WidgetProjectionPolicy.project(
        selection = recreated,
        hostLabel = "Workstation",
        sessionLabel = "Build monitor",
        freshness = CacheFreshness.FRESH,
        observedAtMillis = 69_500,
        nowMillis = 70_000,
        staleAfterMillis = 60_000,
        interactiveOptIn = true,
      )
    assertEquals(WidgetActionDecision.REQUIRES_FRESH_REVALIDATION, fresh.decide(WidgetAction.ABORT, revalidatedAtMillis = null))
    assertEquals(WidgetActionDecision.READY, fresh.decide(WidgetAction.ABORT, revalidatedAtMillis = 70_000))
  }

  @Test
  fun `collection widget is bounded and reports partial stale state`() {
    val projections =
      (1..WidgetCollectionProjection.MAX_COLLECTION_ITEMS).map { index ->
        WidgetProjectionPolicy.project(
          selection = WidgetSelection(selection.copy(sessionId = "session-$index"), WidgetMode.COLLECTION),
          hostLabel = "Workstation",
          sessionLabel = "Session $index",
          freshness = if (index == 8) CacheFreshness.OFFLINE_CACHED else CacheFreshness.FRESH,
          observedAtMillis = 9_500,
          nowMillis = 10_000,
          staleAfterMillis = 60_000,
          interactiveOptIn = false,
        )
      }
    val collection = WidgetProjectionPolicy.collection(projections)
    assertEquals(8, collection.projections.size)
    assertEquals(1, collection.staleCount)
    assertFalse(collection.allFresh)
    assertThrows(IllegalArgumentException::class.java) {
      WidgetProjectionPolicy.collection(projections + projections.first())
    }
  }

  @Test
  fun `app owned deep links round trip saved identities and reject external authority`() {
    val link = PiDroidDeepLinkCodec.encode(selection)
    assertEquals("pidroid://host/workstation/session/session-01", link.toString())
    assertEquals(selection, PiDroidDeepLinkCodec.decode(link, setOf(selection)))
    assertNull(PiDroidDeepLinkCodec.decode(link, emptySet()))
    assertNull(PiDroidDeepLinkCodec.decode(java.net.URI("https://host/workstation/session/session-01"), setOf(selection)))
    assertNull(PiDroidDeepLinkCodec.decode(java.net.URI("pidroid://user@host/workstation/session/session-01"), setOf(selection)))
    assertNull(PiDroidDeepLinkCodec.decode(java.net.URI("pidroid://host/workstation/arbitrary/session-01"), setOf(selection)))
    assertNull(PiDroidDeepLinkCodec.decode(java.net.URI("pidroid://host/workstation/session/session-01?bearer=secret"), setOf(selection)))
    assertNull(PiDroidDeepLinkCodec.decode(java.net.URI("pidroid://host/workstation/session/session-01#fragment"), setOf(selection)))

    val shortcut = SessionShortcut.create(selection, "Build monitor")
    assertEquals(selection, PiDroidDeepLinkCodec.decode(shortcut.deepLink, setOf(selection)))
    assertFalse(shortcut.toString().contains("Build monitor"), "shortcut diagnostics redact labels")
  }

  @Test
  fun `share MVP streams fitting images hashes content and never persists provider URI`() {
    val bytes = ByteArray(10_001) { index -> (index % 251).toByte() }
    val store = FakeShareStagingStore()
    val importer =
      ShareMvpImporter(
        store = store,
        maxSourceBytes = 20_000,
        maxEncodedBytes = 20_000,
        maxFrameBytes = 20_000,
        ttlMillis = 60_000,
        frameEnvelopeBytes = 512,
        copyBufferBytes = 1_024,
      )

    val staged =
      importer.stageImage(
        stagingKey = "share-01",
        source = ByteArrayInputStream(bytes),
        sourceGrantUri = "content://provider/private/42",
        mimeType = "image/png",
        displayName = "../../capture\u0000.png",
        nowMillis = 1_000,
      )

    assertEquals(bytes.size.toLong(), staged.byteCount)
    assertEquals(13_336, staged.base64Bytes)
    assertEquals("capture.png", staged.displayName)
    assertEquals(
      bytes.toList(),
      store.committed
        .getValue("share-01")
        .bytes
        .toList(),
    )
    assertTrue(store.maxWriteSize <= 1_024, "copy must remain chunk bounded")
    assertFalse(staged.toString().contains("content://"))
    assertFalse(staged.toString().contains("provider"))
    assertEquals(64, staged.sha256.length)

    importer.cancel(staged)
    assertFalse("share-01" in store.committed)
  }

  @Test
  fun `share process recreation prunes expired no-backup staging`() {
    val store = FakeShareStagingStore()
    val importer = ShareMvpImporter(store, 8, 12, 12, ttlMillis = 1_000, frameEnvelopeBytes = 0, copyBufferBytes = 4)
    importer.stageImage("share-expired", ByteArrayInputStream(byteArrayOf(1, 2, 3)), "content://provider/1", "image/png", "one.png", 10)
    importer.stageImage("share-current", ByteArrayInputStream(byteArrayOf(4, 5, 6)), "content://provider/2", "image/png", "two.png", 2_000)

    assertEquals(1, importer.recoverAfterProcessDeath(2_500))
    assertFalse("share-expired" in store.committed)
    assertTrue("share-current" in store.committed)
  }

  @Test
  fun `share MVP accepts bounded text and safe URLs but rejects generic files and oversized images`() {
    val importer =
      ShareMvpImporter(
        store = FakeShareStagingStore(),
        maxSourceBytes = 8,
        maxEncodedBytes = 12,
        maxFrameBytes = 12,
        ttlMillis = 60_000,
        frameEnvelopeBytes = 0,
        copyBufferBytes = 4,
      )
    assertEquals(ShareTextKind.TEXT, importer.admitText("follow up").kind)
    assertEquals(ShareTextKind.URL, importer.admitText("https://example.test/work").kind)
    assertThrows(ShareRejectedException::class.java) { importer.admitText("file:///private/report.pdf") }
    assertThrows(ShareRejectedException::class.java) {
      importer.stageImage("share-big", ByteArrayInputStream(ByteArray(9)), "content://provider/1", "image/png", "big.png", 0)
    }
    assertThrows(ShareRejectedException::class.java) {
      importer.stageImage("share-pdf", ByteArrayInputStream(byteArrayOf(1)), "content://provider/2", "application/pdf", "report.pdf", 0)
    }

    val envelopeBound =
      ShareMvpImporter(
        store = FakeShareStagingStore(),
        maxSourceBytes = 8,
        maxEncodedBytes = 12,
        maxFrameBytes = 12,
        ttlMillis = 60_000,
        frameEnvelopeBytes = 9,
        copyBufferBytes = 4,
      )
    assertThrows(ShareRejectedException::class.java) {
      envelopeBound.stageImage(
        "share-frame",
        ByteArrayInputStream(byteArrayOf(1, 2, 3)),
        "content://provider/3",
        "image/png",
        "frame.png",
        0,
      )
    }
  }

  @Test
  fun `Android intent boundaries convert neutral links once and remain package scoped`() {
    val shortcutSource = androidUiFile("src/main/kotlin/com/harryaskham/pidroid/androidui/AndroidSessionShortcutPublisher.kt").readText()
    val widgetSource = androidUiFile("src/main/kotlin/com/harryaskham/pidroid/androidui/AndroidWidgets.kt").readText()

    assertEquals(1, Regex("\\.toAndroidDeepLink\\(\\)").findAll(shortcutSource).count())
    assertEquals(3, Regex("\\.toAndroidDeepLink\\(\\)").findAll(widgetSource).count(), "two callsites plus one extension declaration")
    assertEquals(1, Regex("Uri\\.parse\\(toASCIIString\\(\\)\\)").findAll(widgetSource).count())
    assertTrue(".setPackage(applicationContext.packageName)" in shortcutSource)
    assertTrue(".setPackage(context.packageName)" in widgetSource)
    assertTrue("openAppTemplate(context, appWidgetId)" in widgetSource)
  }

  @Test
  fun `manifest contract is app owned deep link bounded share and non-exported widgets`() {
    assertEquals("pidroid", AndroidUiManifestContract.DEEP_LINK_SCHEME)
    assertEquals(setOf("text/plain", "image/png", "image/jpeg", "image/webp", "image/gif"), AndroidUiManifestContract.SHARE_MIME_TYPES)
    assertFalse(AndroidUiManifestContract.ACCEPTS_GENERIC_DOCUMENTS)
    assertFalse(AndroidUiManifestContract.WIDGET_EXPORTED)
    assertEquals(32, AndroidUiManifestContract.MAX_IMAGE_ITEMS)

    val manifest = androidUiFile("src/main/AndroidManifest.xml").readText()
    assertTrue("android:scheme=\"pidroid\"" in manifest)
    assertTrue("android:name=\".PinnedSessionWidgetProvider\"" in manifest)
    assertTrue("android:name=\".SessionCollectionWidgetProvider\"" in manifest)
    assertEquals(1, Regex("android:exported=\\\"true\\\"").findAll(manifest).count())
    assertEquals(3, Regex("android:exported=\\\"false\\\"").findAll(manifest).count())
    assertEquals(1, Regex("android:name=\\\"android.intent.action.VIEW\\\"").findAll(manifest).count())
    assertEquals(2, Regex("android:name=\\\"android.intent.action.SEND\\\"").findAll(manifest).count())
    assertEquals(1, Regex("android:name=\\\"android.intent.action.SEND_MULTIPLE\\\"").findAll(manifest).count())
    assertFalse("android.intent.action.OPEN_DOCUMENT" in manifest)
    assertFalse("android.intent.action.GET_CONTENT" in manifest)
    assertFalse("application/pdf" in manifest)
    assertFalse("image/*" in manifest)
  }

  private fun androidUiFile(relative: String): java.io.File {
    val candidates =
      listOf(
        java.io.File(relative),
        java.io.File("../sdk-android-ui/$relative"),
        java.io.File("sdk-android-ui/$relative"),
        java.io.File("android/sdk-android-ui/$relative"),
      )
    return candidates.firstOrNull(java.io.File::isFile)
      ?: error("cannot locate sdk-android-ui/$relative from ${java.io.File(".").canonicalPath}")
  }
}

private data class FakeStagedEntry(
  val bytes: ByteArray,
  val expiresAtMillis: Long,
)

private class FakeShareStagingStore : ShareStagingStore {
  val committed = linkedMapOf<String, FakeStagedEntry>()
  private val pending = linkedMapOf<String, ByteArrayOutputStream>()
  var maxWriteSize: Int = 0

  override fun open(stagingKey: String): java.io.OutputStream {
    val output =
      object : ByteArrayOutputStream() {
        override fun write(
          buffer: ByteArray,
          offset: Int,
          length: Int,
        ) {
          maxWriteSize = maxOf(maxWriteSize, length)
          super.write(buffer, offset, length)
        }
      }
    pending[stagingKey] = output
    return output
  }

  override fun commit(
    stagingKey: String,
    expiresAtMillis: Long,
  ) {
    committed[stagingKey] = FakeStagedEntry(pending.remove(stagingKey)!!.toByteArray(), expiresAtMillis)
  }

  override fun discard(stagingKey: String) {
    pending.remove(stagingKey)
    committed.remove(stagingKey)
  }

  override fun pruneExpired(nowMillis: Long): Int {
    val before = committed.size
    committed.entries.removeAll { it.value.expiresAtMillis <= nowMillis }
    pending.clear()
    return before - committed.size
  }
}
