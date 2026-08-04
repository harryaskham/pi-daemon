package com.harryaskham.pidroid.sdk.core

import kotlinx.coroutines.flow.Flow
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale

@JvmInline
public value class HostId(
  public val value: String,
) {
  init {
    require(value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) {
      "host ID must be a bounded stable identifier"
    }
  }
}

public data class PiDaemonHostDescriptor(
  public val id: HostId,
  public val displayName: String,
  public val baseUri: URI,
)

public enum class HttpMethod {
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
}

public class NeutralHeaders private constructor(
  private val valuesByLowercaseName: Map<String, HeaderValue>,
) {
  public operator fun get(name: String): String? = valuesByLowercaseName[name.lowercase(Locale.ROOT)]?.value

  public fun names(): Set<String> = valuesByLowercaseName.values.mapTo(linkedSetOf()) { it.name }

  public fun entries(): Map<String, String> = valuesByLowercaseName.values.associateTo(linkedMapOf()) { it.name to it.value }

  override fun toString(): String = "NeutralHeaders(names=${names()})"

  public companion object {
    private val headerName = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")

    public fun empty(): NeutralHeaders = NeutralHeaders(emptyMap())

    public fun of(values: Map<String, String>): NeutralHeaders {
      val normalized = linkedMapOf<String, HeaderValue>()
      for ((name, value) in values) {
        require(headerName.matches(name)) { "invalid HTTP header name" }
        require(value.length <= 8_192 && '\r' !in value && '\n' !in value) {
          "invalid HTTP header value"
        }
        val lowercaseName = name.lowercase(Locale.ROOT)
        require(lowercaseName !in normalized) { "duplicate HTTP header name" }
        normalized[lowercaseName] = HeaderValue(name, value)
      }
      return NeutralHeaders(normalized)
    }
  }

  private data class HeaderValue(
    val name: String,
    val value: String,
  )
}

public class NeutralHttpRequest(
  public val method: HttpMethod,
  public val uri: URI,
  public val headers: NeutralHeaders,
  body: ByteArray? = null,
) {
  private val body: ByteArray? = body?.copyOf()

  public fun bodyBytes(): ByteArray? = body?.copyOf()

  override fun toString(): String =
    "NeutralHttpRequest(method=$method, uri=$uri, headerNames=${headers.names()}, bodyBytes=${body?.size ?: 0})"
}

public class NeutralHttpResponse(
  public val status: Int,
  public val headers: NeutralHeaders,
  body: ByteArray,
) {
  private val body: ByteArray = body.copyOf()

  init {
    require(status in 100..599) { "HTTP status must be three digits" }
  }

  public fun bodyBytes(): ByteArray = body.copyOf()

  override fun toString(): String = "NeutralHttpResponse(status=$status, headerNames=${headers.names()}, bodyBytes=${body.size})"
}

public class NeutralWebSocketRequest(
  public val uri: URI,
  public val headers: NeutralHeaders,
  public val subprotocols: List<String>,
) {
  init {
    require(subprotocols.isNotEmpty()) { "at least one WebSocket subprotocol is required" }
    require(subprotocols.size <= 8) { "too many WebSocket subprotocols" }
    require(subprotocols.all { it.matches(Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")) }) {
      "invalid WebSocket subprotocol"
    }
  }

  override fun toString(): String = "NeutralWebSocketRequest(uri=$uri, headerNames=${headers.names()}, subprotocols=$subprotocols)"
}

/**
 * Injected host transport boundary for Pi Droid SDK code.
 *
 * The embedding application owns actual HTTP/WebSocket I/O, TLS policy, connection pooling, and
 * cancellation. Implementations must treat request headers and bodies as sensitive, must not log
 * them, and must return bounded responses. SDK UI modules receive repositories/results, never this
 * bearer-bearing request boundary.
 */
public interface PiDaemonTransport {
  public val hosts: Flow<List<PiDaemonHostDescriptor>>

  public suspend fun execute(
    host: HostId,
    request: NeutralHttpRequest,
  ): NeutralHttpResponse

  public fun openWebSocket(
    host: HostId,
    request: NeutralWebSocketRequest,
  ): PiDaemonSocket
}

/**
 * One injected WebSocket connection. Closing it releases transport resources; incoming text remains
 * untrusted until [SessionRpcFrameCodec] validates its bound and envelope.
 */
public interface PiDaemonSocket {
  public val incomingText: Flow<String>

  public suspend fun sendText(text: String)

  public suspend fun close(
    code: Int = 1_000,
    reason: String = "normal",
  )
}

/**
 * Owner-only request factory for the v0 full-authority service bearer.
 *
 * [create] copies the caller's character array, request/header/factory string renderings redact the
 * value, and [close] overwrites the owned copy and permanently disables new requests. Callers retain
 * ownership of their input array and should clear it separately. Already-created requests are
 * intentionally short-lived transport objects and must never cross into UI state, persistence,
 * diagnostics, equality-based models, or logs.
 */
public class ServiceBearerRequestFactory private constructor(
  public val host: PiDaemonHostDescriptor,
  private val bearer: CharArray,
  private val allowInsecureHttp: Boolean,
) : AutoCloseable {
  @Volatile private var closed: Boolean = false

  init {
    validateBaseUri(host.baseUri, allowInsecureHttp)
  }

  public fun http(
    method: HttpMethod,
    path: String,
    query: List<Pair<String, String>> = emptyList(),
    body: ByteArray? = null,
    extraHeaders: Map<String, String> = emptyMap(),
  ): NeutralHttpRequest =
    NeutralHttpRequest(
      method = method,
      uri = resolve(path, query = query, webSocket = false),
      headers = authenticatedHeaders(extraHeaders),
      body = body,
    )

  public fun webSocket(
    path: String,
    query: List<Pair<String, String>>,
    subprotocols: List<String>,
    extraHeaders: Map<String, String> = emptyMap(),
  ): NeutralWebSocketRequest =
    NeutralWebSocketRequest(
      uri = resolve(path, query, webSocket = true),
      headers = authenticatedHeaders(extraHeaders),
      subprotocols = subprotocols.toList(),
    )

  @Synchronized
  override fun close() {
    bearer.fill('\u0000')
    closed = true
  }

  override fun toString(): String = "ServiceBearerRequestFactory(host=${host.id.value}, baseUri=${host.baseUri}, bearer=[REDACTED])"

  @Synchronized
  private fun authenticatedHeaders(extraHeaders: Map<String, String>): NeutralHeaders {
    check(!closed) { "service bearer request factory is closed" }
    require(extraHeaders.keys.none { it.equals("Authorization", ignoreCase = true) }) {
      "authorization header is factory-owned"
    }
    return NeutralHeaders.of(
      linkedMapOf(
        "Accept" to "application/json",
        "Authorization" to "Bearer ${bearer.concatToString()}",
      ) + extraHeaders,
    )
  }

  private fun resolve(
    path: String,
    query: List<Pair<String, String>>,
    webSocket: Boolean,
  ): URI {
    require(path.startsWith('/') && !path.contains("..") && '?' !in path && '#' !in path) {
      "request path must be an absolute API path without traversal or query"
    }
    require(path.length <= 4_096 && '\r' !in path && '\n' !in path) {
      "request path is too long or invalid"
    }
    require(query.size <= 32) { "too many query parameters" }
    val encodedQuery =
      query.joinToString("&") { (name, value) ->
        require(name.matches(Regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$"))) {
          "invalid query parameter name"
        }
        require(value.length <= 2_048 && '\r' !in value && '\n' !in value) {
          "invalid query parameter value"
        }
        "$name=${URLEncoder.encode(value, StandardCharsets.UTF_8.name())}"
      }
    val scheme =
      when {
        !webSocket -> host.baseUri.scheme.lowercase(Locale.ROOT)
        host.baseUri.scheme.equals("https", ignoreCase = true) -> "wss"
        else -> "ws"
      }
    val basePath =
      host.baseUri.path
        .orEmpty()
        .trimEnd('/')
    val querySuffix = encodedQuery.takeIf { it.isNotEmpty() }?.let { "?$it" }.orEmpty()
    return URI.create("$scheme://${host.baseUri.rawAuthority}$basePath$path$querySuffix")
  }

  public companion object {
    public fun create(
      host: PiDaemonHostDescriptor,
      bearer: CharArray,
      allowInsecureHttp: Boolean = false,
    ): ServiceBearerRequestFactory {
      require(bearer.isNotEmpty() && bearer.size <= 4_096) {
        "service bearer must be present and bounded"
      }
      require(bearer.none { it == '\r' || it == '\n' || it == '\u0000' }) {
        "service bearer contains an invalid character"
      }
      return ServiceBearerRequestFactory(host, bearer.copyOf(), allowInsecureHttp)
    }

    private fun validateBaseUri(
      baseUri: URI,
      allowInsecureHttp: Boolean,
    ) {
      require(baseUri.isAbsolute && baseUri.host != null) { "host base URI must be absolute" }
      require(baseUri.userInfo == null && baseUri.query == null && baseUri.fragment == null) {
        "host base URI must not contain user info, query, or fragment"
      }
      require(baseUri.scheme.equals("https", ignoreCase = true) || baseUri.scheme.equals("http", ignoreCase = true)) {
        "host base URI must use HTTP or HTTPS"
      }
      if (baseUri.scheme.equals("http", ignoreCase = true)) {
        require(allowInsecureHttp || isLoopback(baseUri.host)) {
          "remote plaintext HTTP requires explicit operator opt-in"
        }
      }
    }

    private fun isLoopback(host: String): Boolean {
      val normalized = host.lowercase(Locale.ROOT).removePrefix("[").removeSuffix("]")
      return normalized == "localhost" ||
        normalized == "::1" ||
        normalized.startsWith("127.")
    }
  }
}
