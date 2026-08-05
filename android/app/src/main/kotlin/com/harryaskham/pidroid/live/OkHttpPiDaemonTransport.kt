package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.NeutralHeaders
import com.harryaskham.pidroid.sdk.core.NeutralHttpRequest
import com.harryaskham.pidroid.sdk.core.NeutralHttpResponse
import com.harryaskham.pidroid.sdk.core.NeutralWebSocketRequest
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.PiDaemonSocket
import com.harryaskham.pidroid.sdk.core.PiDaemonTransport
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.time.Duration
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Real bounded Android transport for the neutral sdk-core seam.
 *
 * A per-host client is constructed before bearer-bearing requests are admitted. Optional leaf
 * certificate SHA-256 is enforced inside TLS trust evaluation, before HTTP headers can cross the
 * connection. Platform CA and hostname verification remain mandatory.
 */
public interface LiveHostTransport :
  PiDaemonTransport,
  AutoCloseable {
  public fun replaceHosts(hosts: List<RegisteredHost>)
}

public class OkHttpPiDaemonTransport(
  internal val webSocketPingInterval: Duration = DEFAULT_WEBSOCKET_PING_INTERVAL,
) : LiveHostTransport {
  private val descriptors = MutableStateFlow<List<PiDaemonHostDescriptor>>(emptyList())
  private val clients = ConcurrentHashMap<HostId, HostClient>()

  init {
    require(!webSocketPingInterval.isZero && !webSocketPingInterval.isNegative && webSocketPingInterval <= MAX_WEBSOCKET_PING_INTERVAL) {
      "WebSocket ping interval is outside the liveness bound"
    }
  }

  override val hosts: Flow<List<PiDaemonHostDescriptor>> = descriptors

  override fun replaceHosts(hosts: List<RegisteredHost>) {
    require(hosts.map { it.id }.distinct().size == hosts.size) { "host IDs must be unique" }
    val wanted = hosts.mapTo(linkedSetOf()) { it.id }
    clients.keys.filterNot(wanted::contains).forEach { id ->
      clients
        .remove(id)
        ?.client
        ?.dispatcher
        ?.executorService
        ?.shutdown()
    }
    hosts.forEach { host ->
      val current = clients[host.id]
      val fingerprint = host.tlsFingerprint
      if (current == null || current.descriptor.baseUri != host.baseUri || current.tlsFingerprint != fingerprint) {
        current
          ?.client
          ?.dispatcher
          ?.executorService
          ?.shutdown()
        clients[host.id] =
          HostClient(
            descriptor = PiDaemonHostDescriptor(host.id, host.displayName, host.baseUri),
            tlsFingerprint = fingerprint,
            client = buildClient(fingerprint),
          )
      }
    }
    descriptors.value = hosts.map { PiDaemonHostDescriptor(it.id, it.displayName, it.baseUri) }
  }

  override suspend fun execute(
    host: HostId,
    request: NeutralHttpRequest,
  ): NeutralHttpResponse =
    withContext(Dispatchers.IO) {
      val hostClient = requireHost(host, request.uri)
      val builder = Request.Builder().url(request.uri.toString())
      request.headers.entries().forEach { (name, value) -> builder.header(name, value) }
      val body = request.bodyBytes()?.toRequestBody(JSON_MEDIA_TYPE)
      when (request.method.name) {
        "GET" -> builder.get()
        "DELETE" -> if (body == null) builder.delete() else builder.delete(body)
        "POST" -> builder.post(body ?: EMPTY_BODY)
        "PUT" -> builder.put(body ?: EMPTY_BODY)
        "PATCH" -> builder.patch(body ?: EMPTY_BODY)
        else -> error("unsupported HTTP method")
      }
      hostClient.client
        .newCall(builder.build())
        .execute()
        .use(::boundedResponse)
    }

  override fun openWebSocket(
    host: HostId,
    request: NeutralWebSocketRequest,
  ): PiDaemonSocket {
    val hostClient = requireHost(host, request.uri)
    val incoming = Channel<String>(capacity = MAX_INCOMING_FRAMES)
    val incomingClosed = AtomicBoolean(false)

    fun closeIncoming(cause: Throwable? = null) {
      if (!incomingClosed.compareAndSet(false, true)) return
      if (cause == null) incoming.close() else incoming.close(cause)
    }
    val listener =
      object : WebSocketListener() {
        override fun onMessage(
          webSocket: WebSocket,
          text: String,
        ) {
          if (text.length > MAX_WEBSOCKET_CHARS || incoming.trySend(text).isFailure) {
            webSocket.close(1_009, "bounded overflow")
            closeIncoming(IllegalStateException("bounded WebSocket overflow"))
          }
        }

        override fun onMessage(
          webSocket: WebSocket,
          bytes: ByteString,
        ) {
          webSocket.close(1_003, "text frames required")
          closeIncoming(IllegalStateException("binary WebSocket frame rejected"))
        }

        override fun onClosing(
          webSocket: WebSocket,
          code: Int,
          reason: String,
        ) {
          closeIncoming()
          webSocket.close(code, reason.take(MAX_CLOSE_REASON_CHARS))
        }

        override fun onClosed(
          webSocket: WebSocket,
          code: Int,
          reason: String,
        ) {
          closeIncoming()
        }

        override fun onFailure(
          webSocket: WebSocket,
          t: Throwable,
          response: Response?,
        ) {
          val safeBody = response?.body?.charStream()?.use { it.readText().take(4_096) }
          val apiCode = safeBody?.let { Regex("\\\"code\\\"\\s*:\\s*\\\"([a-z0-9_]{1,128})\\\"").find(it)?.groupValues?.get(1) }
          val code = apiCode?.let { "websocket_$it" } ?: response?.code?.let { "websocket_http_$it" } ?: "websocket_failed"
          closeIncoming(TransportFailure(code, t))
        }
      }
    val builder = Request.Builder().url(request.uri.toString())
    request.headers.entries().forEach { (name, value) -> builder.header(name, value) }
    builder.header("Sec-WebSocket-Protocol", request.subprotocols.joinToString(", "))
    val socket = hostClient.client.newWebSocket(builder.build(), listener)
    return AndroidPiDaemonSocket(socket, incoming)
  }

  override fun close() {
    clients.values.forEach {
      it.client.dispatcher.executorService
        .shutdown()
    }
    clients.clear()
    descriptors.value = emptyList()
  }

  private fun requireHost(
    host: HostId,
    uri: URI,
  ): HostClient {
    val client = clients[host] ?: throw IllegalArgumentException("host is not registered with transport")
    val expected = client.descriptor.baseUri
    val schemeMatches =
      uri.scheme.equals(expected.scheme, true) ||
        (expected.scheme.equals("http", true) && uri.scheme.equals("ws", true)) ||
        (expected.scheme.equals("https", true) && uri.scheme.equals("wss", true))
    require(
      schemeMatches &&
        uri.host.equals(expected.host, true) &&
        effectivePort(uri) == effectivePort(expected),
    ) { "request authority does not match registered host" }
    return client
  }

  private fun boundedResponse(response: Response): NeutralHttpResponse {
    val bytes =
      response.body.byteStream().use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1_024)
        var total = 0
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          total += count
          if (total > MAX_RESPONSE_BYTES) throw TransportFailure("response_too_large")
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
    val headers =
      response.headers.names().associateWith { name ->
        response.headers.values(name).joinToString(",")
      }
    return NeutralHttpResponse(response.code, NeutralHeaders.of(headers), bytes)
  }

  private fun buildClient(fingerprint: String?): OkHttpClient {
    val builder =
      OkHttpClient
        .Builder()
        .connectTimeout(Duration.ofSeconds(10))
        .readTimeout(Duration.ofSeconds(20))
        .writeTimeout(Duration.ofSeconds(20))
        .callTimeout(Duration.ofSeconds(30))
        .pingInterval(webSocketPingInterval)
        .retryOnConnectionFailure(false)
    if (fingerprint != null) {
      val delegate = platformTrustManager()
      val pinned = CertificateFingerprintTrustManager(delegate, fingerprint)
      val context = SSLContext.getInstance("TLS")
      context.init(null, arrayOf(pinned), SecureRandom())
      builder.sslSocketFactory(context.socketFactory, pinned)
    }
    return builder.build()
  }

  private fun platformTrustManager(): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as java.security.KeyStore?)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().single()
  }

  private fun effectivePort(uri: URI): Int =
    if (uri.port >= 0) {
      uri.port
    } else if (uri.scheme.equals("https", true) || uri.scheme.equals("wss", true)) {
      443
    } else {
      80
    }

  private data class HostClient(
    val descriptor: PiDaemonHostDescriptor,
    val tlsFingerprint: String?,
    val client: OkHttpClient,
  )

  private companion object {
    const val MAX_RESPONSE_BYTES: Int = 4 * 1_024 * 1_024
    const val MAX_WEBSOCKET_CHARS: Int = 4 * 1_024 * 1_024
    const val MAX_INCOMING_FRAMES: Int = 128
    const val MAX_CLOSE_REASON_CHARS: Int = 123
    val DEFAULT_WEBSOCKET_PING_INTERVAL: Duration = Duration.ofSeconds(5)
    val MAX_WEBSOCKET_PING_INTERVAL: Duration = Duration.ofSeconds(30)
    val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    val EMPTY_BODY = ByteArray(0).toRequestBody(JSON_MEDIA_TYPE)
  }
}

public class CertificateFingerprintTrustManager(
  private val delegate: X509TrustManager,
  fingerprint: String,
) : X509TrustManager {
  private val expected = fingerprint.uppercase(Locale.ROOT)

  override fun checkClientTrusted(
    chain: Array<out X509Certificate>?,
    authType: String?,
  ) {
    delegate.checkClientTrusted(chain, authType)
  }

  override fun checkServerTrusted(
    chain: Array<out X509Certificate>?,
    authType: String?,
  ) {
    delegate.checkServerTrusted(chain, authType)
    val leaf = chain?.firstOrNull() ?: throw CertificateException("server certificate chain is empty")
    val actual = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString(":") { "%02X".format(it) }
    if (actual != expected) throw CertificateException("server certificate fingerprint mismatch")
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers
}

public class TransportFailure(
  public val code: String,
  cause: Throwable? = null,
) : java.io.IOException(code, cause)

private class AndroidPiDaemonSocket(
  private val socket: WebSocket,
  channel: Channel<String>,
) : PiDaemonSocket {
  override val incomingText: Flow<String> = channel.receiveAsFlow()

  override suspend fun sendText(text: String) {
    require(text.length <= 4 * 1_024 * 1_024) { "WebSocket frame exceeds safety bound" }
    if (!socket.send(text)) throw TransportFailure("websocket_send_failed")
  }

  override suspend fun close(
    code: Int,
    reason: String,
  ) {
    if (!socket.close(code, reason.take(123))) socket.cancel()
  }
}
