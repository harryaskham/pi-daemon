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
import kotlinx.coroutines.CancellationException
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
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
  public val rpcObserverEligible: Boolean,
  public val interactiveCommands: Set<PiRpcCommandType>,
)

public data class ExternalCanaryExpectation(
  public val hostInstanceId: String,
  public val inventoryId: String,
  public val observerAttachAllowed: Boolean,
) {
  init {
    require(hostInstanceId.matches(OPAQUE_EXTERNAL_CANARY_ID) && hostInstanceId.length <= 128) {
      "external canary host identity is invalid"
    }
    require(inventoryId.matches(OPAQUE_EXTERNAL_CANARY_ID)) {
      "external canary inventory identity is invalid"
    }
  }
}

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
  private val interactiveConnectMutex = Mutex()
  private val json = Json
  private var activeInteractive: ActiveInteractive? = null
  private var externalCanaryExpectation: ExternalCanaryExpectation? = null

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

  public suspend fun registerExternalCanary(
    envelope: String,
    expectation: ExternalCanaryExpectation,
    confirmInsecureHttp: Boolean,
  ) {
    externalCanaryExpectation = expectation
    registerEnvelope(envelope, confirmInsecureHttp)
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
    transport.prepareReadonlyRefresh()
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

  public suspend fun connectInteractiveObserver() {
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
  }

  public suspend fun requestControl() {
    val active = requireActiveInteractive()
    if (active.machine.snapshot.connection != InteractiveConnectionState.READY) {
      throw LiveReadonlyFailure("interactive_session_not_ready")
    }
    sendOnce(active, active.machine.requestControl())
  }

  public suspend fun releaseControl() {
    val active = requireActiveInteractive()
    sendOnce(active, active.machine.releaseControl())
  }

  public suspend fun reconnectInteractive() {
    closeActiveInteractive()
    connectInteractiveObserver()
  }

  override fun close() {
    scope.cancel()
    transport.close()
  }

  private suspend fun ensureInteractive(): ActiveInteractive =
    interactiveConnectMutex.withLock {
      ensureInteractiveLocked()
    }

  private suspend fun ensureInteractiveLocked(): ActiveInteractive {
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
      attachStage("interactive_credential_failed") {
        credentials.withBearerSuspending(selected.host.credential) { bearer ->
          val descriptor = PiDaemonHostDescriptor(selected.host.id, selected.host.displayName, selected.host.baseUri)
          ServiceBearerRequestFactory
            .create(
              host = descriptor,
              bearer = bearer,
              allowInsecureHttp = selected.host.transportSecurity != TransportSecurity.HTTPS,
            ).use { factory ->
              val client = PiDaemonClient(descriptor, factory, transport)
              if (
                PiRpcCommandType.PROMPT !in selected.interactiveCommands ||
                PiRpcCommandType.GET_TREE !in selected.interactiveCommands
              ) {
                throw LiveReadonlyFailure("interactive_capabilities_failed")
              }
              val machine =
                LiveInteractiveSessionMachine(
                  session = SessionKey(sessionId, generation),
                  supportedCommands = selected.interactiveCommands,
                  authority = selected.session.host.authority,
                  modelLabel = selected.session.session.modelLabel ?: "default model",
                  thinkingLevel = selected.session.session.thinkingLevel ?: "default",
                )
              val rpcSocket =
                attachStage("observer_connect_failed") {
                  client.attach(SessionKey(sessionId, generation), SessionRole.OBSERVER)
                }
              try {
                val first =
                  attachStage("observer_connect_failed") {
                    withTimeout(10_000) { rpcSocket.incomingText.first() }
                  }
                machine.accept(first)
                if (
                  machine.snapshot.connection != InteractiveConnectionState.READY ||
                  machine.snapshot.role != InteractiveControllerRole.OBSERVER
                ) {
                  throw LiveReadonlyFailure("observer_connect_failed")
                }
                val tuiMachine = LiveTuiSessionMachine()
                val encoded = URLEncoder.encode(sessionId, StandardCharsets.UTF_8.name()).replace("+", "%20")
                val tuiSocket =
                  attachStage("interactive_tui_open_failed") {
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
                  }
                OpenedInteractive(machine, rpcSocket, tuiMachine, tuiSocket)
              } catch (error: Throwable) {
                rpcSocket.close()
                throw error
              }
            }
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
          publishInteractive(active, "transport_lost")
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

          val expectation = externalCanaryExpectation
          if (expectation != null && hostInstanceId != expectation.hostInstanceId) {
            throw LiveReadonlyFailure("external_canary_host_changed")
          }
          val inventoryEnvelope = get(factory, "/v1/dashboard/inventory?limit=50")
          val inventorySelection = selectInventory(inventoryEnvelope, expectation?.inventoryId)
          val encodedId =
            URLEncoder.encode(inventorySelection.inventoryId, StandardCharsets.UTF_8.name()).replace("+", "%20")
          val infoEnvelope = get(factory, "/v1/dashboard/inventory/$encodedId")
          val transcriptEnvelope = get(factory, "/v1/dashboard/inventory/$encodedId/transcript?limit=50")
          val observerSafe =
            observerAttachIsSafe(inventorySelection, infoEnvelope) &&
              transcriptAllowsObserver(inventorySelection.inventoryId, transcriptEnvelope)
          if (expectation?.observerAttachAllowed == true && !observerSafe) {
            throw LiveReadonlyFailure("external_canary_session_unsafe")
          }
          val observerEligible = observerSafe && expectation?.observerAttachAllowed != false
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
              observerEligible && session.session.sessionId != null && session.session.generation != null &&
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
          LiveHostSession(
            host = host,
            session = session,
            rpcObserverConnected = rpcConnected,
            rpcObserverEligible = observerEligible,
            interactiveCommands = InteractiveCapabilities.from(capabilitySuccess.value).commands,
          )
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

  private fun selectInventory(
    envelope: String,
    expectedInventoryId: String?,
  ): InventorySelection {
    require(envelope.length <= 4 * 1_024 * 1_024) { "inventory response is too large" }
    val root = json.parseToJsonElement(envelope) as? JsonObject ?: throw LiveReadonlyFailure("invalid_inventory")
    val sessions =
      ((root["data"] as? JsonObject)?.get("sessions") as? JsonArray)
        ?: throw LiveReadonlyFailure("invalid_inventory")
    val records = sessions.mapNotNull { it as? JsonObject }
    val selected =
      if (expectedInventoryId == null) {
        records.firstOrNull()
      } else {
        records.firstOrNull { record ->
          (record["inventoryId"] as? JsonPrimitive)?.contentOrNull == expectedInventoryId
        }
      } ?: throw LiveReadonlyFailure(
        if (expectedInventoryId == null) "inventory_empty" else "external_canary_session_changed",
      )
    val inventoryId =
      (selected["inventoryId"] as? JsonPrimitive)
        ?.contentOrNull
        ?.takeIf { it.matches(OPAQUE_EXTERNAL_CANARY_ID) }
        ?: throw LiveReadonlyFailure("invalid_inventory")
    return InventorySelection(inventoryId, idleManagedIdentity(selected))
  }

  private fun observerAttachIsSafe(
    selection: InventorySelection,
    informationEnvelope: String,
  ): Boolean {
    val root = json.parseToJsonElement(informationEnvelope) as? JsonObject ?: return false
    val information = root["data"] as? JsonObject ?: return false
    return selection.idleManagedIdentity != null && selection.idleManagedIdentity == idleManagedIdentity(information)
  }

  private fun transcriptAllowsObserver(
    inventoryId: String,
    transcriptEnvelope: String,
  ): Boolean {
    val root = json.parseToJsonElement(transcriptEnvelope) as? JsonObject ?: return false
    val transcript = root["data"] as? JsonObject ?: return false
    if ((transcript["inventoryId"] as? JsonPrimitive)?.contentOrNull != inventoryId) return false
    if (transcript["quarantine"] != null) return false
    val availability = transcript["availability"] as? JsonObject ?: return false
    val freshness = transcript["freshness"] as? JsonObject ?: return false
    return (availability["state"] as? JsonPrimitive)?.contentOrNull == "available" &&
      (availability["observerAttachAllowed"] as? JsonPrimitive)?.booleanOrNull == true &&
      (freshness["state"] as? JsonPrimitive)?.contentOrNull == "current"
  }

  private fun idleManagedIdentity(record: JsonObject): ManagedIdentity? {
    val managed = record["managed"] as? JsonObject ?: return null
    if (managed["recovery"] != null) return null
    val presence = record["presence"] as? JsonObject ?: return null
    if (
      (managed["state"] as? JsonPrimitive)?.contentOrNull != "idle" ||
      (presence["runtime"] as? JsonPrimitive)?.contentOrNull != "resident-idle"
    ) {
      return null
    }
    val sessionId =
      (managed["sessionId"] as? JsonPrimitive)
        ?.contentOrNull
        ?.takeIf { it.matches(OPAQUE_EXTERNAL_CANARY_ID) }
        ?: return null
    val generation = (managed["generation"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 } ?: return null
    return ManagedIdentity(sessionId, generation)
  }

  private fun failureCode(error: Throwable?): String =
    when (error) {
      is LiveReadonlyFailure -> error.code
      is TransportFailure -> error.code
      else -> "host_unavailable"
    }
}

private data class InventorySelection(
  val inventoryId: String,
  val idleManagedIdentity: ManagedIdentity?,
)

private data class ManagedIdentity(
  val sessionId: String,
  val generation: Int,
)

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

private suspend fun <T> attachStage(
  fallbackCode: String,
  block: suspend () -> T,
): T =
  try {
    block()
  } catch (error: CancellationException) {
    throw error
  } catch (error: CommandAdmissionException) {
    throw error
  } catch (error: LiveReadonlyFailure) {
    throw error
  } catch (error: TransportFailure) {
    throw error
  } catch (error: ProtocolDecodeException) {
    throw error
  } catch (_: Throwable) {
    throw LiveReadonlyFailure(fallbackCode)
  }

private val INTERACTIVE_SAFE_CODE = Regex("^[a-z][a-z0-9_]{0,127}$")
private val OPAQUE_EXTERNAL_CANARY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

public class LiveReadonlyFailure(
  public val code: String,
) : IllegalStateException(code)
