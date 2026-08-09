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

  public suspend fun dashboardCapabilities(): ApiResult<DashboardCapabilities> {
    val request = requestFactory.http(HttpMethod.GET, "/v1/dashboard/capabilities")
    return SessionLifecycleCodec.decodeDashboardCapabilities(transport.execute(host.id, request))
  }

  public suspend fun listSessions(
    limit: Int = 50,
    cursor: String? = null,
  ): ApiResult<ManagedSessionPage> {
    require(limit in 1..100) { "session list limit must be between one and 100" }
    validateCursor(cursor)
    val request =
      requestFactory.http(
        HttpMethod.GET,
        "/v1/session",
        query =
          buildList {
            add("limit" to limit.toString())
            cursor?.let { add("cursor" to it) }
          },
      )
    return SessionLifecycleCodec.decodeSessionPage(transport.execute(host.id, request))
  }

  public suspend fun session(sessionRef: String): ApiResult<ManagedSessionResource> {
    validateReference(sessionRef, "session reference")
    val request = requestFactory.http(HttpMethod.GET, "/v1/session/${encodePathSegment(sessionRef)}")
    return SessionLifecycleCodec.decodeSession(transport.execute(host.id, request))
  }

  /** Create only from the daemon-advertised configured defaults; no caller cwd/path is accepted. */
  public suspend fun createConfiguredSession(
    capabilities: DashboardCapabilities,
    identity: DurableRequestIdentity,
    sessionId: String? = null,
    name: String? = null,
  ): ApiResult<DurableTicket> {
    val defaults =
      capabilities.configuredSessionDefaults
        ?: throw CapabilityUnavailableException(
          "configured_session_defaults_unavailable",
          "daemon did not advertise configured session defaults",
        )
    val request =
      requestFactory.http(
        HttpMethod.POST,
        "/v1/session",
        body = SessionLifecycleCodec.configuredCreateBody(defaults, identity, sessionId, name),
        extraHeaders = mutationHeaders(identity),
      )
    return SessionApiCodec.decodeTicket(transport.execute(host.id, request))
  }

  public suspend fun ticket(ticketId: String): ApiResult<DurableTicket> {
    validateReference(ticketId, "ticket ID")
    val request = requestFactory.http(HttpMethod.GET, "/v1/ticket/${encodePathSegment(ticketId)}")
    return SessionApiCodec.decodeTicket(transport.execute(host.id, request))
  }

  /** Explicit evidence-backed reconciliation; this never retries the accepted mutation. */
  public suspend fun reconcileTicket(
    ticketId: String,
    reconciliation: TicketReconciliation,
  ): ApiResult<DurableTicket> {
    validateReference(ticketId, "ticket ID")
    val request =
      requestFactory.http(
        HttpMethod.POST,
        "/v1/ticket/${encodePathSegment(ticketId)}/reconcile",
        body = SessionLifecycleCodec.reconciliationBody(reconciliation),
        extraHeaders =
          mapOf(
            "Content-Type" to "application/json",
            "X-Request-Id" to reconciliation.requestId,
          ),
      )
    return SessionApiCodec.decodeTicket(transport.execute(host.id, request))
  }

  public suspend fun listInventory(
    limit: Int = 50,
    cursor: String? = null,
    search: String? = null,
  ): ApiResult<DashboardInventoryPage> {
    require(limit in 1..100) { "inventory limit must be between one and 100" }
    validateCursor(cursor)
    search?.let {
      require(it.isNotEmpty() && it.length <= 1_024 && '\r' !in it && '\n' !in it) {
        "inventory search must be present and bounded"
      }
    }
    val request =
      requestFactory.http(
        HttpMethod.GET,
        "/v1/dashboard/inventory",
        query =
          buildList {
            add("limit" to limit.toString())
            cursor?.let { add("cursor" to it) }
            search?.let { add("search" to it) }
          },
      )
    return SessionLifecycleCodec.decodeInventory(transport.execute(host.id, request))
  }

  public suspend fun inventoryInfo(inventoryId: String): ApiResult<DashboardSessionInfo> {
    validateReference(inventoryId, "inventory ID")
    val request = requestFactory.http(HttpMethod.GET, "/v1/dashboard/inventory/${encodePathSegment(inventoryId)}")
    return SessionLifecycleCodec.decodeSessionInfo(transport.execute(host.id, request))
  }

  public suspend fun transcript(
    inventoryId: String,
    limit: Int = 50,
    cursor: String? = null,
    expectedFingerprint: String? = null,
  ): ApiResult<DashboardTranscript> {
    validateReference(inventoryId, "inventory ID")
    require(limit in 1..200) { "transcript limit must be between one and 200" }
    validateCursor(cursor)
    expectedFingerprint?.let {
      require(it.isNotEmpty() && it.length <= 512 && '\r' !in it && '\n' !in it) {
        "source fingerprint must be present and bounded"
      }
    }
    val request =
      requestFactory.http(
        HttpMethod.GET,
        "/v1/dashboard/inventory/${encodePathSegment(inventoryId)}/transcript",
        query =
          buildList {
            add("limit" to limit.toString())
            cursor?.let { add("cursor" to it) }
            expectedFingerprint?.let { add("fingerprint" to it) }
          },
      )
    return SessionLifecycleCodec.decodeTranscript(transport.execute(host.id, request))
  }

  /** Adopt an already-managed inventory row by verifying its exact retained generation. */
  public suspend fun adoptExisting(record: DashboardInventoryRecord): ApiResult<SessionAdoption.Existing> {
    val managed =
      record.managed
        ?: throw CapabilityUnavailableException("managed_session_unavailable", "inventory row has no managed session identity")
    return when (val result = session(managed.key.sessionId)) {
      is ApiResult.Failure -> {
        result
      }

      is ApiResult.Success -> {
        if (result.value.key != managed.key) {
          throw ProtocolDecodeException(
            "session_identity_mismatch",
            "managed inventory identity no longer matches retained session generation",
          )
        }
        ApiResult.Success(result.requestId, result.hostInstanceId, SessionAdoption.Existing(record.inventoryId, result.value))
      }
    }
  }

  /** Request a durable `reuse` activation only when the inventory row advertises it. */
  public suspend fun activateForReuse(
    record: DashboardInventoryRecord,
    identity: DurableRequestIdentity,
    expectedFingerprint: String? = null,
  ): ApiResult<DashboardActivationTicket> {
    if (!record.activation.eligible || DashboardActivationMode.REUSE !in record.activation.modes) {
      throw CapabilityUnavailableException("reuse_activation_unavailable", "inventory row is not eligible for reuse activation")
    }
    val request =
      requestFactory.http(
        HttpMethod.POST,
        "/v1/dashboard/inventory/${encodePathSegment(record.inventoryId)}/activate",
        body = SessionLifecycleCodec.activationBody(identity, expectedFingerprint),
        extraHeaders = mutationHeaders(identity),
      )
    return SessionLifecycleCodec.decodeActivationTicket(transport.execute(host.id, request))
  }

  public suspend fun activation(ticketId: String): ApiResult<DashboardActivationTicket> {
    validateReference(ticketId, "activation ticket ID")
    val request = requestFactory.http(HttpMethod.GET, "/v1/dashboard/activation/${encodePathSegment(ticketId)}")
    return SessionLifecycleCodec.decodeActivationTicket(transport.execute(host.id, request))
  }

  public fun attach(
    session: SessionKey,
    role: SessionRole,
    cursor: String? = null,
  ): PiDaemonSocket = attach(session, role, cursor, hydrate = false)

  /** Attach with explicit retained-session hydration; callers must not infer hydration from replay state. */
  public fun attach(
    session: SessionKey,
    role: SessionRole,
    cursor: String?,
    hydrate: Boolean,
  ): PiDaemonSocket {
    validateCursor(cursor)
    val query =
      buildList {
        add("generation" to session.generation.toString())
        add("role" to role.wireValue)
        if (hydrate) add("hydrate" to "true")
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

  /** Attach only when a transcript's exact availability/freshness authority permits observation. */
  public fun attachObserver(
    transcript: DashboardTranscript,
    cursor: String? = null,
    hydrate: Boolean = false,
  ): PiDaemonSocket {
    val session =
      transcript.observerSession
        ?: throw CapabilityUnavailableException(
          "observer_attach_unavailable",
          "transcript authority does not permit observer attachment",
        )
    return attach(session, SessionRole.OBSERVER, cursor, hydrate)
  }

  public fun attachTui(
    capabilities: DashboardCapabilities,
    session: SessionKey,
    role: SessionRole = SessionRole.OBSERVER,
    rows: Int,
    columns: Int,
    cursor: String? = null,
  ): PiDaemonSocket {
    if (!capabilities.tui.available || capabilities.tui.subprotocol != "pi-daemon-tui.v1") {
      throw CapabilityUnavailableException("tui_unavailable", "daemon did not advertise the supported TUI transport")
    }
    val maxRows = capabilities.limits["maxTuiRows"] ?: 200
    val maxColumns = capabilities.limits["maxTuiColumns"] ?: 320
    require(rows in 1..maxRows) { "TUI rows exceed the negotiated bound" }
    require(columns in 1..maxColumns) { "TUI columns exceed the negotiated bound" }
    validateCursor(cursor)
    val request =
      requestFactory.webSocket(
        path = "/v1/dashboard/session/${encodePathSegment(session.sessionId)}/tui",
        query =
          buildList {
            add("generation" to session.generation.toString())
            add("role" to role.wireValue)
            add("rows" to rows.toString())
            add("columns" to columns.toString())
            cursor?.let { add("cursor" to it) }
          },
        subprotocols = listOf("pi-daemon-tui.v1"),
      )
    return transport.openWebSocket(host.id, request)
  }

  override fun toString(): String = "PiDaemonClient(host=${host.id.value}, transport=[INJECTED])"

  private fun mutationHeaders(identity: DurableRequestIdentity): Map<String, String> =
    mapOf(
      "Content-Type" to "application/json",
      "Idempotency-Key" to identity.idempotencyKey,
      "X-Request-Id" to identity.requestId,
    )

  private fun validateCursor(cursor: String?) {
    if (cursor != null) {
      require(cursor.isNotEmpty() && cursor.length <= 1_024 && '\r' !in cursor && '\n' !in cursor) {
        "replay cursor is invalid or too long"
      }
    }
  }

  private fun validateReference(
    value: String,
    label: String,
  ) {
    require(value.isNotEmpty() && value.length <= 256 && '\r' !in value && '\n' !in value && '\u0000' !in value) {
      "$label must be present and bounded"
    }
  }

  private fun encodePathSegment(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")
}
