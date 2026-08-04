package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.sdk.core.ApiResult
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HttpMethod
import com.harryaskham.pidroid.sdk.core.PairingPayload
import com.harryaskham.pidroid.sdk.core.PairingPayloadCodec
import com.harryaskham.pidroid.sdk.core.PiDaemonClient
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.ServiceBearerRequestFactory
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sdk.core.SessionRole
import com.harryaskham.pidroid.sdk.core.SessionRpcFrame
import com.harryaskham.pidroid.sdk.core.SessionRpcFrameCodec
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import com.harryaskham.pidroid.sessionui.SessionFixtureDecoder
import com.harryaskham.pidroid.sessionui.SessionHostContext
import com.harryaskham.pidroid.sessionui.SessionSurfaceReducer
import com.harryaskham.pidroid.sessionui.SessionSurfaceState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

public sealed interface LiveReadonlyState {
  public data object Unconfigured : LiveReadonlyState

  public data class Loading(
    public val message: String,
  ) : LiveReadonlyState

  public data class Ready(
    public val hosts: List<LiveHostSession>,
    public val selectedHostId: HostId,
  ) : LiveReadonlyState {
    public val selected: LiveHostSession = requireNotNull(hosts.firstOrNull { it.host.id == selectedHostId })
  }

  public data class Failure(
    public val code: String,
    public val retryable: Boolean,
  ) : LiveReadonlyState
}

public data class LiveHostSession(
  public val host: RegisteredHost,
  public val session: SessionSurfaceState,
  public val rpcObserverConnected: Boolean,
)

public class LiveReadonlyRepository(
  private val registry: HostRegistry,
  private val credentials: HostCredentialVault,
  private val transport: LiveHostTransport,
) : AutoCloseable {
  private val mutableState = MutableStateFlow<LiveReadonlyState>(LiveReadonlyState.Unconfigured)
  private val json = Json

  public val state: StateFlow<LiveReadonlyState> = mutableState.asStateFlow()

  public suspend fun initialize() {
    val hosts = registry.list()
    if (hosts.isEmpty()) {
      transport.replaceHosts(emptyList())
      mutableState.value = LiveReadonlyState.Unconfigured
    } else {
      refresh()
    }
  }

  public suspend fun registerEnvelope(
    envelope: String,
    confirmInsecureHttp: Boolean,
  ) {
    val payload = PairingPayloadCodec.decode(envelope)
    val existing = registry.list().firstOrNull { it.baseUri == payload.apiUri }
    if (existing != null) {
      payload.close()
    } else {
      registry.register(payload, confirmInsecureHttp)
    }
    refresh()
  }

  public suspend fun registerManual(
    apiUri: URI,
    displayName: String,
    bearer: CharArray,
    tlsFingerprint: String?,
    confirmInsecureHttp: Boolean,
  ) {
    try {
      registry.register(
        PairingPayload.create(apiUri, displayName, bearer, tlsFingerprint),
        confirmInsecureHttp,
      )
    } finally {
      bearer.fill('\u0000')
    }
    refresh()
  }

  public suspend fun refresh() {
    val hosts = registry.list()
    if (hosts.isEmpty()) {
      mutableState.value = LiveReadonlyState.Unconfigured
      return
    }
    transport.replaceHosts(hosts)
    val previous = (mutableState.value as? LiveReadonlyState.Ready)?.hosts.orEmpty()
    if (previous.isNotEmpty()) {
      mutableState.value =
        LiveReadonlyState.Ready(
          hosts =
            previous.map { snapshot ->
              snapshot.copy(
                session = SessionSurfaceReducer.withFreshness(snapshot.session, CacheFreshness.RECONNECTING, 0),
                rpcObserverConnected = false,
              )
            },
          selectedHostId = previous.first().host.id,
        )
    } else {
      mutableState.value = LiveReadonlyState.Loading("Connecting to registered Pi Daemon hosts")
    }

    val snapshots = mutableListOf<LiveHostSession>()
    val failures = mutableListOf<Throwable>()
    for (host in hosts) {
      try {
        snapshots += refreshHost(host, previous.firstOrNull { it.host.id == host.id })
      } catch (error: Throwable) {
        failures += error
        previous.firstOrNull { it.host.id == host.id }?.let { cached ->
          snapshots +=
            cached.copy(
              session = SessionSurfaceReducer.withFreshness(cached.session, CacheFreshness.OFFLINE_CACHED, 0),
              rpcObserverConnected = false,
            )
        }
      }
    }
    if (snapshots.isNotEmpty()) {
      val previousSelected = (mutableState.value as? LiveReadonlyState.Ready)?.selectedHostId
      mutableState.value =
        LiveReadonlyState.Ready(
          hosts = snapshots,
          selectedHostId = previousSelected?.takeIf { id -> snapshots.any { it.host.id == id } } ?: snapshots.first().host.id,
        )
    } else {
      mutableState.value = LiveReadonlyState.Failure(failureCode(failures.firstOrNull()), retryable = true)
    }
  }

  public fun reportFailure(code: String) {
    mutableState.value = LiveReadonlyState.Failure(code.take(128), retryable = true)
  }

  public fun selectHost(hostId: HostId) {
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: return
    if (ready.hosts.any { it.host.id == hostId }) mutableState.value = ready.copy(selectedHostId = hostId)
  }

  public suspend fun removeHost(hostId: HostId) {
    registry.remove(hostId)
    refresh()
  }

  override fun close() {
    transport.close()
  }

  private suspend fun refreshHost(
    host: RegisteredHost,
    previous: LiveHostSession?,
  ): LiveHostSession =
    credentials.withBearerSuspending(host.credential) { bearer ->
      val descriptor = PiDaemonHostDescriptor(host.id, host.displayName, host.baseUri)
      ServiceBearerRequestFactory
        .create(
          host = descriptor,
          bearer = bearer,
          allowInsecureHttp = host.transportSecurity != TransportSecurity.HTTPS,
        ).use { factory ->
          val client = PiDaemonClient(descriptor, factory, transport)
          val capabilities = client.capabilities()
          val capabilitySuccess =
            capabilities as? ApiResult.Success
              ?: throw LiveReadonlyFailure((capabilities as ApiResult.Failure).error.code)
          val hostInstanceId = capabilitySuccess.hostInstanceId
          if (previous != null && previous.session.host.authority.hostInstanceId != hostInstanceId) {
            mutableState.value =
              LiveReadonlyState.Ready(
                hosts =
                  listOf(
                    previous.copy(
                      session = SessionSurfaceReducer.withFreshness(previous.session, CacheFreshness.RESYNCING, 0),
                      rpcObserverConnected = false,
                    ),
                  ),
                selectedHostId = host.id,
              )
          }

          val inventoryEnvelope = get(factory, "/v1/dashboard/inventory?limit=50")
          val inventoryId = firstInventoryId(inventoryEnvelope)
          val encodedId = URLEncoder.encode(inventoryId, StandardCharsets.UTF_8.name()).replace("+", "%20")
          val infoEnvelope = get(factory, "/v1/dashboard/inventory/$encodedId")
          val transcriptEnvelope = get(factory, "/v1/dashboard/inventory/$encodedId/transcript?limit=50")
          val authority = HostAuthority(host.id, host.bearerGeneration, hostInstanceId)
          val session =
            SessionFixtureDecoder.decode(
              host = SessionHostContext(host.id, host.displayName, authority, CacheFreshness.FRESH, 0),
              inventoryEnvelope = inventoryEnvelope,
              infoEnvelope = infoEnvelope,
              transcriptEnvelope = transcriptEnvelope,
            )
          val rpcConnected =
            if (
              session.session.sessionId != null && session.session.generation != null &&
              capabilitySuccess.value.rpcSubprotocols.contains("pi-daemon-rpc.v1")
            ) {
              runCatching {
                val socket =
                  client.attach(
                    SessionKey(session.session.sessionId, session.session.generation),
                    SessionRole.OBSERVER,
                  )
                try {
                  val ready = withTimeout(10_000) { SessionRpcFrameCodec.decode(socket.incomingText.first()) }
                  ready is SessionRpcFrame.AttachReady &&
                    ready.role == SessionRole.OBSERVER &&
                    ready.hostInstanceId == hostInstanceId &&
                    ready.sessionId == session.session.sessionId &&
                    ready.generation == session.session.generation
                } finally {
                  socket.close()
                }
              }.getOrDefault(false)
            } else {
              false
            }
          LiveHostSession(host, session, rpcConnected)
        }
    }

  private suspend fun get(
    factory: ServiceBearerRequestFactory,
    pathAndQuery: String,
  ): String {
    val delimiter = pathAndQuery.indexOf('?')
    val path = pathAndQuery.takeIf { delimiter < 0 } ?: pathAndQuery.substring(0, delimiter)
    val query = if (delimiter < 0) emptyList() else parseQuery(pathAndQuery.substring(delimiter + 1))
    val request = factory.http(HttpMethod.GET, path, query = query)
    val response = transport.execute(factory.host.id, request)
    if (response.status !in 200..299) throw LiveReadonlyFailure("http_${response.status}")
    return response.bodyBytes().decodeToString(throwOnInvalidSequence = true)
  }

  private fun parseQuery(value: String): List<Pair<String, String>> =
    value.split('&').filter(String::isNotEmpty).map { component ->
      val parts = component.split('=', limit = 2)
      parts.first() to parts.getOrElse(1) { "" }
    }

  private fun firstInventoryId(envelope: String): String {
    require(envelope.length <= 4 * 1_024 * 1_024) { "inventory response is too large" }
    val root = json.parseToJsonElement(envelope) as? JsonObject ?: throw LiveReadonlyFailure("invalid_inventory")
    val sessions =
      ((root["data"] as? JsonObject)?.get("sessions") as? JsonArray)
        ?: throw LiveReadonlyFailure("invalid_inventory")
    val first = sessions.firstOrNull() as? JsonObject ?: throw LiveReadonlyFailure("inventory_empty")
    return (first["inventoryId"] as? JsonPrimitive)
      ?.contentOrNull
      ?.takeIf { it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")) }
      ?: throw LiveReadonlyFailure("invalid_inventory")
  }

  private fun failureCode(error: Throwable?): String =
    when (error) {
      is LiveReadonlyFailure -> error.code
      is TransportFailure -> error.code
      else -> "host_unavailable"
    }
}

public class LiveReadonlyFailure(
  public val code: String,
) : IllegalStateException(code)
