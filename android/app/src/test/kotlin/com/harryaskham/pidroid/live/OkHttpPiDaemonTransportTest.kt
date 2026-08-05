package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.sdk.core.CredentialHandle
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HttpMethod
import com.harryaskham.pidroid.sdk.core.NeutralHttpRequest
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.ServiceBearerRequestFactory
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.tls.HeldCertificate
import okio.ByteString
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.security.cert.X509Certificate
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.X509TrustManager

class OkHttpPiDaemonTransportTest {
  @Test
  fun `bounded HTTP carries bearer without rendering it`() =
    runTest {
      val server = MockWebServer()
      server.start()
      try {
        server.enqueue(
          MockResponse
            .Builder()
            .code(200)
            .addHeader("Content-Type", "application/json")
            .body("""{"ok":true}""")
            .build(),
        )
        val host = host(server.url("/").toString())
        val transport = OkHttpPiDaemonTransport().also { it.replaceHosts(listOf(host)) }
        val bearer = "disposable-test-bearer".toCharArray()
        ServiceBearerRequestFactory.create(descriptor(host), bearer, allowInsecureHttp = true).use { factory ->
          val request = factory.http(HttpMethod.GET, "/v1/capabilities", query = listOf("limit" to "1"))
          assertFalse(request.toString().contains(bearer.concatToString()))
          val response = transport.execute(host.id, request)
          assertEquals(200, response.status)
          assertEquals("""{"ok":true}""", response.bodyBytes().decodeToString())
          val recorded = server.takeRequest()
          assertEquals("Bearer disposable-test-bearer", recorded.headers["Authorization"])
          assertEquals("1", recorded.url.queryParameter("limit"))
        }
        bearer.fill('\u0000')
        transport.close()
      } finally {
        server.close()
      }
    }

  @Test
  fun `text WebSocket is bounded and delivers through injected socket`() =
    runTest {
      val server = MockWebServer()
      server.start()
      try {
        val listener =
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              webSocket.send("readonly-ready")
              webSocket.close(1_000, "fixture complete")
            }
          }
        server.enqueue(
          MockResponse
            .Builder()
            .addHeader("Sec-WebSocket-Protocol", "pi-daemon-rpc.v1")
            .webSocketUpgrade(listener)
            .build(),
        )
        val host = host(server.url("/").toString())
        val transport = OkHttpPiDaemonTransport().also { it.replaceHosts(listOf(host)) }
        ServiceBearerRequestFactory.create(descriptor(host), "test".toCharArray(), allowInsecureHttp = true).use { factory ->
          val socket =
            factory
              .webSocket("/v1/session/test/rpc", emptyList(), listOf("pi-daemon-rpc.v1"))
              .let { transport.openWebSocket(host.id, it) }
          val message =
            withContext(Dispatchers.Default.limitedParallelism(1)) {
              withTimeout(5_000) { socket.incomingText.first() }
            }
          assertEquals("readonly-ready", message)
          socket.close()
        }
        transport.close()
      } finally {
        server.close()
      }
    }

  @Test
  fun `WebSocket ping liveness interval is bounded and defaults to five seconds`() {
    assertEquals(Duration.ofSeconds(5), OkHttpPiDaemonTransport().webSocketPingInterval)
    assertEquals(Duration.ofSeconds(1), OkHttpPiDaemonTransport(Duration.ofSeconds(1)).webSocketPingInterval)
    assertThrows(IllegalArgumentException::class.java) { OkHttpPiDaemonTransport(Duration.ZERO) }
    assertThrows(IllegalArgumentException::class.java) { OkHttpPiDaemonTransport(Duration.ofSeconds(31)) }
  }

  @Test
  fun `peer closing helper acknowledges bounded reason and closes incoming exactly once`() {
    val causes = mutableListOf<Throwable?>()
    val closer = IncomingChannelCloser(causes::add)
    val socket = FakeWebSocket()

    acknowledgePeerClosing(socket, 1_001, "x".repeat(200), closer)
    closer.close()

    assertEquals(listOf<Throwable?>(null), causes)
    assertEquals(1, socket.closeCalls)
    assertEquals(1_001, socket.closeCode)
    assertEquals(123, socket.closeReason?.length)
  }

  @Test
  fun `MockWebServer graceful close race produces typed safe failure within bound`() =
    runTest {
      val server = MockWebServer()
      server.start()
      try {
        val acceptedSocket = CompletableDeferred<WebSocket>()
        server.enqueue(
          MockResponse
            .Builder()
            .addHeader("Sec-WebSocket-Protocol", "pi-daemon-rpc.v1")
            .webSocketUpgrade(
              object : WebSocketListener() {
                override fun onOpen(
                  webSocket: WebSocket,
                  response: Response,
                ) {
                  acceptedSocket.complete(webSocket)
                }
              },
            ).build(),
        )
        val serverAddress = server.url("/").toString()
        val host = host(serverAddress)
        val transport = OkHttpPiDaemonTransport().also { it.replaceHosts(listOf(host)) }
        ServiceBearerRequestFactory.create(descriptor(host), "test".toCharArray(), allowInsecureHttp = true).use { factory ->
          val socket =
            factory
              .webSocket("/v1/session/test/rpc", emptyList(), listOf("pi-daemon-rpc.v1"))
              .let { transport.openWebSocket(host.id, it) }
          val incoming = async(Dispatchers.Default) { socket.incomingText.toList() }
          val serverSocket = withTimeout(5_000) { acceptedSocket.await() }
          assertTrue(serverSocket.close(1_001, "server shutdown"))
          val failure = withTimeout(15_000) { runCatching { incoming.await() }.exceptionOrNull() }
          assertTrue(failure is TransportFailure)
          assertEquals("websocket_failed", (failure as TransportFailure).code)
          assertFalse(failure.toString().contains(serverAddress))
          socket.close()
        }
        transport.close()
      } finally {
        server.close()
      }
    }

  @Test
  fun `connection refusal closes incoming with typed safe failure`() =
    runTest {
      val server = MockWebServer()
      server.start()
      val serverAddress = server.url("/").toString()
      server.close()
      val host = host(serverAddress)
      val transport = OkHttpPiDaemonTransport().also { it.replaceHosts(listOf(host)) }
      ServiceBearerRequestFactory.create(descriptor(host), "test".toCharArray(), allowInsecureHttp = true).use { factory ->
        val socket =
          factory
            .webSocket("/v1/session/test/rpc", emptyList(), listOf("pi-daemon-rpc.v1"))
            .let { transport.openWebSocket(host.id, it) }
        val failure = withTimeout(15_000) { runCatching { socket.incomingText.toList() }.exceptionOrNull() }
        assertTrue(failure is TransportFailure)
        assertEquals("websocket_failed", (failure as TransportFailure).code)
        assertFalse(failure.toString().contains(serverAddress))
        socket.close()
      }
      transport.close()
    }

  @Test
  fun `certificate fingerprint is checked only after platform trust`() {
    val certificate =
      HeldCertificate
        .Builder()
        .commonName("localhost")
        .build()
        .certificate
    val fingerprint = sha256(certificate)
    val delegateCalled = AtomicBoolean(false)
    val delegate =
      object : X509TrustManager {
        override fun checkClientTrusted(
          chain: Array<out X509Certificate>?,
          authType: String?,
        ) = Unit

        override fun checkServerTrusted(
          chain: Array<out X509Certificate>?,
          authType: String?,
        ) {
          delegateCalled.set(true)
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }
    val trust = CertificateFingerprintTrustManager(delegate, fingerprint)
    trust.checkServerTrusted(arrayOf(certificate), "RSA")
    assertTrue(delegateCalled.get())

    delegateCalled.set(false)
    val mismatch = CertificateFingerprintTrustManager(delegate, "00:".repeat(31) + "00")
    assertThrows(java.security.cert.CertificateException::class.java) {
      mismatch.checkServerTrusted(arrayOf(certificate), "RSA")
    }
    assertTrue(delegateCalled.get())
  }

  private class FakeWebSocket : WebSocket {
    var closeCalls: Int = 0
      private set
    var closeCode: Int? = null
      private set
    var closeReason: String? = null
      private set

    override fun request(): Request = Request.Builder().url("http://127.0.0.1/").build()

    override fun queueSize(): Long = 0

    override fun send(text: String): Boolean = false

    override fun send(bytes: ByteString): Boolean = false

    override fun close(
      code: Int,
      reason: String?,
    ): Boolean {
      closeCalls += 1
      closeCode = code
      closeReason = reason
      return true
    }

    override fun cancel() = Unit
  }

  private fun host(baseUri: String): RegisteredHost {
    val id = HostId("test-host")
    return RegisteredHost(
      id = id,
      displayName = "Test host",
      baseUri = URI(baseUri),
      tlsFingerprint = null,
      transportSecurity = TransportSecurity.LOOPBACK_PLAINTEXT,
      bearerGeneration = 0,
      credential = CredentialHandle(id, 0),
    )
  }

  private fun descriptor(host: RegisteredHost): PiDaemonHostDescriptor = PiDaemonHostDescriptor(host.id, host.displayName, host.baseUri)

  private fun sha256(certificate: X509Certificate): String =
    java.security.MessageDigest
      .getInstance("SHA-256")
      .digest(certificate.encoded)
      .joinToString(":") { "%02X".format(it) }
}
