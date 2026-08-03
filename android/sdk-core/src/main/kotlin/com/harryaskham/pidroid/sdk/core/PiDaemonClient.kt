package com.harryaskham.pidroid.sdk.core

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

public data class SessionKey(
  public val sessionId: String,
  public val generation: Int,
) {
  init {
    require(sessionId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) {
      "session ID must be a bounded stable identifier"
    }
    require(generation >= 0) { "session generation must be non-negative" }
  }
}

/**
 * Thin fixture-backed SDK facade over an injected [PiDaemonTransport].
 *
 * The client owns no bearer bytes and never closes the caller-owned transport or request factory.
 * Callers must close [ServiceBearerRequestFactory] when its credential lifetime ends and close every
 * returned [PiDaemonSocket]. A socket is not authoritative until an `attach_ready` frame matches the
 * requested session generation. `replay_gap` is an explicit resynchronization boundary: discard the
 * incompatible cursor/events and wait for the advertised snapshot instead of replaying a command.
 */
public class PiDaemonClient(
  public val host: PiDaemonHostDescriptor,
  private val requestFactory: ServiceBearerRequestFactory,
  private val transport: PiDaemonTransport,
) {
  init {
    require(requestFactory.host == host) { "request factory must be bound to the same host descriptor" }
  }

  public suspend fun capabilities(): ApiResult<HostCapabilities> {
    val request = requestFactory.http(HttpMethod.GET, "/v1/capabilities")
    return SessionApiCodec.decodeCapabilities(transport.execute(host.id, request))
  }

  public fun attach(
    session: SessionKey,
    role: SessionRole,
    cursor: String? = null,
  ): PiDaemonSocket {
    if (cursor != null) {
      require(cursor.isNotEmpty() && cursor.length <= 1_024 && '\r' !in cursor && '\n' !in cursor) {
        "replay cursor is invalid or too long"
      }
    }
    val query =
      buildList {
        add("generation" to session.generation.toString())
        add("role" to role.wireValue)
        cursor?.let { add("cursor" to it) }
      }
    val request =
      requestFactory.webSocket(
        path = "/v1/session/${encodePathSegment(session.sessionId)}/rpc",
        query = query,
        subprotocols = listOf("pi-daemon-rpc.v1"),
      )
    return transport.openWebSocket(host.id, request)
  }

  override fun toString(): String = "PiDaemonClient(host=${host.id.value}, transport=[INJECTED])"

  private fun encodePathSegment(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")
}
