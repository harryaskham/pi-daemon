package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import com.harryaskham.pidroid.sdk.core.ApiResult
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.CommandAdmissionException
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HttpMethod
import com.harryaskham.pidroid.sdk.core.InteractiveCapabilities
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.PairingPayload
import com.harryaskham.pidroid.sdk.core.PairingPayloadCodec
import com.harryaskham.pidroid.sdk.core.PiDaemonClient
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.ProtocolDecodeException
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.ServiceBearerRequestFactory
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sdk.core.SessionRole
import com.harryaskham.pidroid.sdk.core.SessionRpcFrame
import com.harryaskham.pidroid.sdk.core.SessionRpcFrameCodec
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import com.harryaskham.pidroid.sessionui.SessionFixtureDecoder
import com.harryaskham.pidroid.sessionui.SessionHostContext
import com.harryaskham.pidroid.sessionui.SessionSurfaceReducer
import com.harryaskham.pidroid.sessionui.SessionSurfaceState
import com.harryaskham.pidroid.sessionui.TuiFrameState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID

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

public sealed interface LiveInteractiveAppState {
  public data object Inactive : LiveInteractiveAppState

  public data class Connecting(
    public val hostId: HostId,
  ) : LiveInteractiveAppState

  public data class Ready(
    public val hostId: HostId,
    public val sessionId: String,
    public val generation: Int,
    public val snapshot: LiveInteractiveSnapshot,
    public val tui: TuiFrameState?,
  ) : LiveInteractiveAppState

  public data class Failure(
    public val hostId: HostId?,
    public val sessionId: String?,
    public val generation: Int?,
    public val code: String,
    public val lastSnapshot: LiveInteractiveSnapshot?,
  ) : LiveInteractiveAppState
}

public class LiveReadonlyRepository(
  private val registry: HostRegistry,
  private val credentials: HostCredentialVault,
  private val transport: LiveHostTransport,
) : AutoCloseable {
  private val mutableState = MutableStateFlow<LiveReadonlyState>(LiveReadonlyState.Unconfigured)
  private val mutableInteractiveState = MutableStateFlow<LiveInteractiveAppState>(LiveInteractiveAppState.Inactive)
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json
  private var activeInteractive: ActiveInteractive? = null

  public val state: StateFlow<LiveReadonlyState> = mutableState.asStateFlow()
  public val interactiveState: StateFlow<LiveInteractiveAppState> = mutableInteractiveState.asStateFlow()

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

  public fun reportInteractiveFailure(code: String) {
    val safeCode = code.takeIf(INTERACTIVE_SAFE_CODE::matches) ?: "interactive_failed"
    val existing = mutableInteractiveState.value as? LiveInteractiveAppState.Failure
    if (safeCode == "interactive_failed" && existing != null && existing.code != "interactive_failed") return
    val active = activeInteractive
    if (active == null) {
      val selected = (mutableState.value as? LiveReadonlyState.Ready)?.selected
      mutableInteractiveState.value =
        LiveInteractiveAppState.Failure(
          hostId = selected?.host?.id,
          sessionId = selected?.session?.session?.sessionId,
          generation = selected?.session?.session?.generation,
          code = safeCode,
          lastSnapshot = null,
        )
    } else {
      publishInteractive(active, safeCode)
    }
  }

  public fun selectHost(hostId: HostId) {
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: return
    if (ready.hosts.any { it.host.id == hostId }) mutableState.value = ready.copy(selectedHostId = hostId)
  }

  public suspend fun removeHost(hostId: HostId) {
    if (activeInteractive?.hostId == hostId) closeActiveInteractive()
    registry.remove(hostId)
    refresh()
  }

  public suspend fun handleInteraction(action: RichInteractionAction) {
    when (action) {
      RichInteractionAction.RequestControl -> {
        requestControl()
      }

      RichInteractionAction.ReleaseControl -> {
        releaseControl()
      }

      is RichInteractionAction.DraftChanged -> {
        val active = requireActiveInteractive()
        active.machine.changeDraft(action.text)
        publishInteractive(active)
      }

      else -> {
        val active = requireActiveInteractive()
        val prefix =
          when (action) {
            is RichInteractionAction.SubmitPrompt -> "wake"
            is RichInteractionAction.SubmitFollowUp -> "follow-up"
            is RichInteractionAction.Steer -> "steer"
            is RichInteractionAction.SetModel -> "model"
            is RichInteractionAction.SetThinkingLevel -> "thinking"
            RichInteractionAction.Abort -> "abort"
            is RichInteractionAction.DraftChanged -> "draft"
            RichInteractionAction.RequestControl -> "control"
            RichInteractionAction.ReleaseControl -> "control"
          }
        val correlationId = "$prefix-${UUID.randomUUID()}"
        val outbound = active.machine.submit(action, correlationId)
        sendOnce(active, outbound)
      }
    }
  }

  public suspend fun requestControl() {
    val active =
      try {
        ensureInteractive()
      } catch (error: CommandAdmissionException) {
        throw error
      } catch (error: LiveReadonlyFailure) {
        throw error
      } catch (error: TransportFailure) {
        throw error
      } catch (error: ProtocolDecodeException) {
        throw error
      } catch (_: Throwable) {
        val failure = LiveReadonlyFailure("interactive_attach_failed")
        reportInteractiveFailure(failure.code)
        throw failure
      }
    sendOnce(active, active.machine.requestControl())
  }

  public suspend fun releaseControl() {
    val active = requireActiveInteractive()
    sendOnce(active, active.machine.releaseControl())
  }

  public suspend fun reconnectInteractive() {
    closeActiveInteractive()
    requestControl()
  }

  override fun close() {
    scope.cancel()
    transport.close()
  }

  private suspend fun ensureInteractive(): ActiveInteractive {
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: throw LiveReadonlyFailure("interactive_host_not_ready")
    val selected = ready.selected
    if (selected.session.host.freshness != CacheFreshness.FRESH) {
      throw LiveReadonlyFailure("interactive_freshness_required")
    }
    val sessionId = selected.session.session.sessionId ?: throw LiveReadonlyFailure("interactive_session_unavailable")
    val generation = selected.session.session.generation ?: throw LiveReadonlyFailure("interactive_session_unavailable")
    activeInteractive
      ?.takeIf {
        it.hostId == selected.host.id &&
          it.authority == selected.session.host.authority &&
          it.session == SessionKey(sessionId, generation) &&
          it.machine.snapshot.connection == InteractiveConnectionState.READY
      }?.let { return it }

    closeActiveInteractive()
    mutableInteractiveState.value = LiveInteractiveAppState.Connecting(selected.host.id)
    val opened =
      credentials.withBearerSuspending(selected.host.credential) { bearer ->
        val descriptor = PiDaemonHostDescriptor(selected.host.id, selected.host.displayName, selected.host.baseUri)
        ServiceBearerRequestFactory
          .create(
            host = descriptor,
            bearer = bearer,
            allowInsecureHttp = selected.host.transportSecurity != TransportSecurity.HTTPS,
          ).use { factory ->
            val client = PiDaemonClient(descriptor, factory, transport)
            val capabilities =
              when (val result = client.capabilities()) {
                is ApiResult.Success -> result.value
                is ApiResult.Failure -> throw LiveReadonlyFailure(result.error.code)
              }
            val machine =
              LiveInteractiveSessionMachine(
                session = SessionKey(sessionId, generation),
                supportedCommands = InteractiveCapabilities.from(capabilities).commands,
                authority = selected.session.host.authority,
                modelLabel = selected.session.session.modelLabel ?: "default model",
                thinkingLevel = selected.session.session.thinkingLevel ?: "default",
              )
            val rpcSocket = client.attach(SessionKey(sessionId, generation), SessionRole.OBSERVER)
            val first = withTimeout(10_000) { rpcSocket.incomingText.first() }
            machine.accept(first)
            if (
              machine.snapshot.connection != InteractiveConnectionState.READY ||
              machine.snapshot.role != InteractiveControllerRole.OBSERVER
            ) {
              rpcSocket.close()
              throw LiveReadonlyFailure("interactive_observer_attach_failed")
            }
            val tuiMachine = LiveTuiSessionMachine()
            val encoded = URLEncoder.encode(sessionId, StandardCharsets.UTF_8.name()).replace("+", "%20")
            val tuiSocket =
              transport.openWebSocket(
                selected.host.id,
                factory.webSocket(
                  path = "/v1/dashboard/session/$encoded/tui",
                  query =
                    listOf(
                      "generation" to generation.toString(),
                      "role" to "observer",
                      "rows" to "24",
                      "columns" to "80",
                    ),
                  subprotocols = listOf("pi-daemon-tui.v1"),
                ),
              )
            OpenedInteractive(machine, rpcSocket, tuiMachine, tuiSocket)
          }
      }
    val active =
      ActiveInteractive(
        hostId = selected.host.id,
        session = SessionKey(sessionId, generation),
        authority = selected.session.host.authority,
        machine = opened.machine,
        rpcSocket = opened.rpcSocket,
        tuiMachine = opened.tuiMachine,
        tuiSocket = opened.tuiSocket,
      )
    activeInteractive = active
    publishInteractive(active)
    active.rpcJob =
      scope.launch {
        try {
          active.rpcSocket.incomingText.collect { text ->
            val wasController = active.machine.snapshot.role == InteractiveControllerRole.CONTROLLER
            active.machine.accept(text)
            publishInteractive(active)
            if (!wasController && active.machine.snapshot.role == InteractiveControllerRole.CONTROLLER &&
              active.machine.snapshot.tree == null
            ) {
              sendOnce(active, active.machine.requestTree("tree-${UUID.randomUUID()}"))
            }
          }
        } catch (_: Throwable) {
          // The finally block converts every missing acknowledgement to indeterminate.
        } finally {
          active.machine.disconnected()
          publishInteractive(active, "interactive_disconnected")
        }
      }
    active.tuiJob =
      scope.launch {
        try {
          active.tuiSocket.incomingText.collect { text ->
            active.tuiMachine.accept(text)
            publishInteractive(active)
          }
        } catch (_: Throwable) {
          publishInteractive(active)
        }
      }
    return active
  }

  private fun requireActiveInteractive(): ActiveInteractive {
    val active = activeInteractive ?: throw LiveReadonlyFailure("interactive_session_not_attached")
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: throw LiveReadonlyFailure("interactive_host_not_ready")
    val selected = ready.selected
    if (
      selected.host.id != active.hostId ||
      selected.session.host.authority != active.authority ||
      selected.session.host.freshness != CacheFreshness.FRESH ||
      selected.session.session.sessionId != active.session.sessionId ||
      selected.session.session.generation != active.session.generation
    ) {
      active.machine.disconnected()
      publishInteractive(active, "interactive_freshness_required")
      throw LiveReadonlyFailure("interactive_freshness_required")
    }
    return active
  }

  private suspend fun sendOnce(
    active: ActiveInteractive,
    text: String,
  ) {
    try {
      active.rpcSocket.sendText(text)
      publishInteractive(active)
    } catch (_: Throwable) {
      active.machine.disconnected()
      publishInteractive(active, "interactive_send_indeterminate")
      throw LiveReadonlyFailure("interactive_send_indeterminate")
    }
  }

  private fun publishInteractive(
    active: ActiveInteractive,
    failure: String? = null,
  ) {
    if (activeInteractive !== active) return
    mutableInteractiveState.value =
      if (failure == null) {
        LiveInteractiveAppState.Ready(
          hostId = active.hostId,
          sessionId = active.session.sessionId,
          generation = active.session.generation,
          snapshot = active.machine.snapshot,
          tui = active.tuiMachine.state,
        )
      } else {
        LiveInteractiveAppState.Failure(
          hostId = active.hostId,
          sessionId = active.session.sessionId,
          generation = active.session.generation,
          code = failure,
          lastSnapshot = active.machine.snapshot,
        )
      }
  }

  private suspend fun closeActiveInteractive() {
    val active = activeInteractive ?: return
    activeInteractive = null
    active.rpcJob?.cancel()
    active.tuiJob?.cancel()
    runCatching { active.rpcSocket.close() }
    runCatching { active.tuiSocket.close() }
    mutableInteractiveState.value = LiveInteractiveAppState.Inactive
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

private data class OpenedInteractive(
  val machine: LiveInteractiveSessionMachine,
  val rpcSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
  val tuiMachine: LiveTuiSessionMachine,
  val tuiSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
)

private data class ActiveInteractive(
  val hostId: HostId,
  val session: SessionKey,
  val authority: HostAuthority,
  val machine: LiveInteractiveSessionMachine,
  val rpcSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
  val tuiMachine: LiveTuiSessionMachine,
  val tuiSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
  var rpcJob: Job? = null,
  var tuiJob: Job? = null,
)

private val INTERACTIVE_SAFE_CODE = Regex("^[a-z][a-z0-9_]{0,127}$")

public class LiveReadonlyFailure(
  public val code: String,
) : IllegalStateException(code)
