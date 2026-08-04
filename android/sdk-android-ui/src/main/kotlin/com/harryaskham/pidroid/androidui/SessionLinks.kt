package com.harryaskham.pidroid.androidui

import com.harryaskham.pidroid.sdk.core.HostId
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

public data class SavedSessionSelection(
  public val hostId: HostId,
  public val sessionId: String,
) {
  init {
    require(sessionId.isBoundedAndroidUiIdentifier()) { "saved session ID is invalid" }
  }

  public companion object {
    public fun from(
      hostId: String,
      sessionId: String,
    ): SavedSessionSelection = SavedSessionSelection(HostId(hostId), sessionId)
  }
}

/** Strict app-owned deep links. External hosts, query data and unsaved identities are rejected. */
public object PiDroidDeepLinkCodec {
  public fun encode(selection: SavedSessionSelection): URI =
    URI.create(
      "$DEEP_LINK_SCHEME://host/${encodeSegment(selection.hostId.value)}/session/${encodeSegment(selection.sessionId)}",
    )

  public fun decode(
    uri: URI,
    savedSelections: Set<SavedSessionSelection>,
  ): SavedSessionSelection? =
    runCatching {
      require(uri.scheme == DEEP_LINK_SCHEME)
      require(uri.host == "host" && uri.userInfo == null && uri.port == -1)
      require(uri.rawQuery == null && uri.rawFragment == null)
      val segments = uri.rawPath.split('/').filter(String::isNotEmpty)
      require(segments.size == 3 && segments[1] == "session")
      val selection = SavedSessionSelection.from(decodeSegment(segments[0]), decodeSegment(segments[2]))
      selection.takeIf(savedSelections::contains)
    }.getOrNull()

  private fun encodeSegment(value: String): String = URLEncoder.encode(value, UTF_8).replace("+", "%20")

  private fun decodeSegment(value: String): String = URLDecoder.decode(value, UTF_8)

  public const val DEEP_LINK_SCHEME: String = "pidroid"
  private const val UTF_8: String = "UTF-8"
}

public class SessionShortcut private constructor(
  public val shortcutId: String,
  public val label: String,
  public val deepLink: URI,
) {
  init {
    require(shortcutId.isBoundedAndroidUiIdentifier()) { "shortcut ID is invalid" }
    require(label.isNotBlank() && label.length <= 64 && '\r' !in label && '\n' !in label) {
      "shortcut label is invalid"
    }
  }

  override fun toString(): String = "SessionShortcut(shortcutId=$shortcutId, deepLink=$deepLink, label=[REDACTED])"

  public companion object {
    public fun create(
      selection: SavedSessionSelection,
      label: String,
    ): SessionShortcut {
      val digest =
        MessageDigest
          .getInstance("SHA-256")
          .digest("${selection.hostId.value}\u0000${selection.sessionId}".toByteArray(StandardCharsets.UTF_8))
          .take(12)
          .joinToString("") { "%02x".format(it.toInt() and 0xff) }
      return SessionShortcut("session-$digest", label, PiDroidDeepLinkCodec.encode(selection))
    }
  }
}

internal fun String.isBoundedAndroidUiIdentifier(): Boolean = matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"))
