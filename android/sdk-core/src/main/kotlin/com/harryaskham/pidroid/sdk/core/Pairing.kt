package com.harryaskham.pidroid.sdk.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI
import java.util.Base64
import java.util.Locale

public class PairingPayloadException(
  public val code: String,
  message: String,
) : IllegalArgumentException(message)

public enum class TransportSecurity {
  HTTPS,
  LOOPBACK_PLAINTEXT,
  EXPLICIT_REMOTE_PLAINTEXT,
}

/**
 * Version-1 stable-bearer pairing payload. The bearer is copied into owner-only mutable storage,
 * omitted from equality/hash/rendering, exposed only to a bounded callback, and overwritten by
 * [close]. This object must never enter UI state, persistence, analytics, or structured logs.
 */
public class PairingPayload private constructor(
  public val apiUri: URI,
  public val displayName: String,
  public val tlsFingerprint: String?,
  public val transportSecurity: TransportSecurity,
  private val bearer: CharArray,
) : AutoCloseable {
  @Volatile private var closed: Boolean = false

  @Synchronized
  public fun <T> useBearer(block: (CharArray) -> T): T {
    check(!closed) { "pairing payload is closed" }
    val temporary = bearer.copyOf()
    return try {
      block(temporary)
    } finally {
      temporary.fill('\u0000')
    }
  }

  public suspend fun <T> useBearerSuspending(block: suspend (CharArray) -> T): T {
    val temporary =
      synchronized(this) {
        check(!closed) { "pairing payload is closed" }
        bearer.copyOf()
      }
    return try {
      block(temporary)
    } finally {
      temporary.fill('\u0000')
    }
  }

  @Synchronized
  override fun close() {
    bearer.fill('\u0000')
    closed = true
  }

  override fun toString(): String =
    "PairingPayload(version=1, apiUri=$apiUri, displayName=$displayName, tlsFingerprint=${tlsFingerprint != null}, transportSecurity=$transportSecurity, bearer=[REDACTED])"

  public companion object {
    private val DISPLAY_NAME = Regex("^[^\\p{Cc}\\p{Cf}]{1,128}$")
    private val TLS_FINGERPRINT = Regex("^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$")

    public fun create(
      apiUri: URI,
      displayName: String,
      bearer: CharArray,
      tlsFingerprint: String? = null,
    ): PairingPayload {
      require(apiUri.isAbsolute && apiUri.host != null) { "pairing API URI must be absolute" }
      require(apiUri.userInfo == null && apiUri.query == null && apiUri.fragment == null) {
        "pairing API URI must not contain user info, query, or fragment"
      }
      require(apiUri.path.isNullOrEmpty() || apiUri.path == "/") {
        "pairing API URI must not contain an application path"
      }
      require(apiUri.scheme.equals("https", true) || apiUri.scheme.equals("http", true)) {
        "pairing API URI must use HTTP or HTTPS"
      }
      require(DISPLAY_NAME.matches(displayName)) { "pairing display name is invalid or too long" }
      require(bearer.isNotEmpty() && bearer.size <= 4_096) { "pairing bearer is missing or too long" }
      require(bearer.none { it == '\r' || it == '\n' || it == '\u0000' }) {
        "pairing bearer contains an invalid character"
      }
      val normalizedFingerprint = tlsFingerprint?.uppercase(Locale.ROOT)
      require(normalizedFingerprint == null || TLS_FINGERPRINT.matches(normalizedFingerprint)) {
        "pairing TLS fingerprint must be a SHA-256 fingerprint"
      }
      val security =
        when {
          apiUri.scheme.equals("https", true) -> TransportSecurity.HTTPS
          isLoopback(apiUri.host) -> TransportSecurity.LOOPBACK_PLAINTEXT
          else -> TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT
        }
      return PairingPayload(
        apiUri = apiUri.normalize(),
        displayName = displayName,
        bearer = bearer.copyOf(),
        tlsFingerprint = normalizedFingerprint,
        transportSecurity = security,
      )
    }

    private fun isLoopback(host: String): Boolean {
      val normalized = host.lowercase(Locale.ROOT).removePrefix("[").removeSuffix("]")
      return normalized == "localhost" || normalized == "::1" || normalized.startsWith("127.")
    }
  }
}

/**
 * Canonical printable envelope carried inside a terminal-rendered or scanned QR code. Rendering the
 * QR matrix is intentionally outside sdk-core; this codec defines only deterministic bounded ASCII.
 * The encoded envelope contains the full service bearer and is itself secret: never place it in
 * argv, shell history, structured logs, screenshots, analytics, clipboard history, or persistence.
 */
public object PairingPayloadCodec {
  private const val PREFIX: String = "pidroid://pair/v1/"
  private const val MAX_ENCODED_CHARS: Int = 16_384
  private const val MAX_JSON_BYTES: Int = 8_192
  private val encoder: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()
  private val decoder: Base64.Decoder = Base64.getUrlDecoder()

  public fun encode(payload: PairingPayload): String {
    val encoded =
      payload.useBearer { bearer ->
        val fields =
          linkedMapOf<String, kotlinx.serialization.json.JsonElement>(
            "version" to JsonPrimitive(1),
            "apiUrl" to JsonPrimitive(payload.apiUri.toASCIIString()),
            "displayName" to JsonPrimitive(payload.displayName),
            "bearer" to JsonPrimitive(bearer.concatToString()),
          )
        payload.tlsFingerprint?.let { fields["tlsFingerprint"] = JsonPrimitive(it) }
        val bytes = JsonObject(fields).toString().encodeToByteArray()
        require(bytes.size <= MAX_JSON_BYTES) { "pairing payload exceeds the QR safety bound" }
        encoder.encodeToString(bytes)
      }
    return "$PREFIX$encoded".also {
      require(it.length <= MAX_ENCODED_CHARS) { "pairing envelope exceeds the QR safety bound" }
    }
  }

  public fun decode(envelope: String): PairingPayload {
    if (
      envelope.length !in (PREFIX.length + 1)..MAX_ENCODED_CHARS ||
      envelope.any { it.code !in 0x20..0x7E } ||
      !envelope.startsWith(PREFIX)
    ) {
      throw PairingPayloadException("invalid_envelope", "pairing envelope is invalid or unsupported")
    }
    val bytes =
      try {
        decoder.decode(envelope.removePrefix(PREFIX))
      } catch (_: IllegalArgumentException) {
        throw PairingPayloadException("invalid_encoding", "pairing envelope encoding is invalid")
      }
    val root =
      try {
        SessionApiCodec.decodeObject(bytes, MAX_JSON_BYTES, "pairing payload")
      } catch (error: ProtocolDecodeException) {
        throw PairingPayloadException(error.code, "pairing payload is invalid")
      }
    val known = setOf("version", "apiUrl", "displayName", "bearer", "tlsFingerprint")
    if (root.keys.any { it !in known }) {
      throw PairingPayloadException("unsupported_field", "pairing payload contains an unsupported field")
    }
    val version = (root["version"] as? JsonPrimitive)?.content
    if (version != "1") {
      throw PairingPayloadException("unsupported_version", "pairing payload version is unsupported")
    }
    return try {
      val apiUri = URI(root.requiredString("apiUrl"))
      val bearer = root.requiredString("bearer").toCharArray()
      try {
        PairingPayload.create(
          apiUri = apiUri,
          displayName = root.requiredString("displayName"),
          bearer = bearer,
          tlsFingerprint = root.optionalString("tlsFingerprint"),
        )
      } finally {
        bearer.fill('\u0000')
      }
    } catch (_: Exception) {
      throw PairingPayloadException("invalid_payload", "pairing payload fields are invalid")
    }
  }
}
