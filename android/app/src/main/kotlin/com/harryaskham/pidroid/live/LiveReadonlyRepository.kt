package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import com.harryaskham.pidroid.sdk.core.ApiResult
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.CommandAdmissionException
import com.harryaskham.pidroid.sdk.core.ConfiguredSessionDefaults
import com.harryaskham.pidroid.sdk.core.ConnectionAttemptId
import com.harryaskham.pidroid.sdk.core.DashboardActivationMode
import com.harryaskham.pidroid.sdk.core.DashboardCapabilities
import com.harryaskham.pidroid.sdk.core.DashboardInventoryPage
import com.harryaskham.pidroid.sdk.core.DashboardInventoryRecord
import com.harryaskham.pidroid.sdk.core.DurableRequestIdentity
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostCredentialVault
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.HostRegistry
import com.harryaskham.pidroid.sdk.core.HttpMethod
import com.harryaskham.pidroid.sdk.core.IncomingFrameDisposition
import com.harryaskham.pidroid.sdk.core.InteractiveCapabilities
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.PairingPayload
import com.harryaskham.pidroid.sdk.core.PairingPayloadCodec
import com.harryaskham.pidroid.sdk.core.PiDaemonClient
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.ProtocolDecodeException
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.ResumableCommand
import com.harryaskham.pidroid.sdk.core.ServiceBearerRequestFactory
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sdk.core.SessionLifecycleCoordinator
import com.harryaskham.pidroid.sdk.core.SessionResumeSnapshotCodec
import com.harryaskham.pidroid.sdk.core.SessionRole
import com.harryaskham.pidroid.sdk.core.SessionRpcFrame
import com.harryaskham.pidroid.sdk.core.SessionRpcFrameCodec
import com.harryaskham.pidroid.sdk.core.TicketState
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import com.harryaskham.pidroid.sessionui.SessionHostContext
import com.harryaskham.pidroid.sessionui.SessionLifecycleProjection
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
  public val session: SessionSurfaceState?,
  public val catalog: LiveSessionCatalog,
  public val rpcObserverConnected: Boolean,
  public val rpcObserverEligible: Boolean,
  public val interactiveCommands: Set<PiRpcCommandType>,
)

public sealed interface HostManagementNotice {
  public data class Added(
    public val hostId: HostId,
  ) : HostManagementNotice

  public data class Updated(
    public val hostId: HostId,
  ) : HostManagementNotice

  public data class Repaired(
    public val hostId: HostId,
  ) : HostManagementNotice

  public data class Forgotten(
    public val displayName: String,
  ) : HostManagementNotice

  public data class DuplicateEndpoint(
    public val hostId: HostId,
  ) : HostManagementNotice

  public data class Failure(
    public val code: String,
  ) : HostManagementNotice
}

public data class HostManagementState(
  public val hosts: List<RegisteredHost> = emptyList(),
  public val defaultHostId: HostId? = null,
  public val notice: HostManagementNotice? = null,
)

public interface DefaultHostStore {
  public suspend fun read(): HostId?

  public suspend fun write(hostId: HostId?)
}

private class EphemeralDefaultHostStore : DefaultHostStore {
  private var hostId: HostId? = null

  override suspend fun read(): HostId? = hostId

  override suspend fun write(hostId: HostId?) {
    this.hostId = hostId
  }
}

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
  private val defaultHostStore: DefaultHostStore = EphemeralDefaultHostStore(),
  private val dailyDriverStore: DailyDriverStore = EphemeralDailyDriverStore(),
) : AutoCloseable {
  private val mutableState = MutableStateFlow<LiveReadonlyState>(LiveReadonlyState.Unconfigured)
  private val mutableInteractiveState = MutableStateFlow<LiveInteractiveAppState>(LiveInteractiveAppState.Inactive)
  private val mutableHostManagementState = MutableStateFlow(HostManagementState())
  private val mutableSessionActionState = MutableStateFlow<LiveSessionActionState>(LiveSessionActionState.Idle)
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val interactiveConnectMutex = Mutex()
  private val json = Json
  private var activeInteractive: ActiveInteractive? = null
  private var externalCanaryExpectation: ExternalCanaryExpectation? = null
  private var defaultHostId: HostId? = null
  private val lifecycleByHost = linkedMapOf<HostId, HostLifecycleData>()

  public val state: StateFlow<LiveReadonlyState> = mutableState.asStateFlow()
  public val interactiveState: StateFlow<LiveInteractiveAppState> = mutableInteractiveState.asStateFlow()
  public val hostManagementState: StateFlow<HostManagementState> = mutableHostManagementState.asStateFlow()
  public val sessionActionState: StateFlow<LiveSessionActionState> = mutableSessionActionState.asStateFlow()

  public suspend fun initialize() {
    val hosts = registry.list()
    val persistedDefault = defaultHostStore.read()
    defaultHostId = persistedDefault?.takeIf { candidate -> hosts.any { it.id == candidate } } ?: hosts.firstOrNull()?.id
    if (defaultHostId != persistedDefault) defaultHostStore.write(defaultHostId)
    publishRegisteredHosts(hosts)
    if (hosts.isEmpty()) {
      transport.replaceHosts(emptyList())
      mutableState.value = LiveReadonlyState.Unconfigured
    } else {
      refresh()
      restoreInteractiveResume()
      restoreSessionAction()
    }
  }

  public suspend fun registerEnvelope(
    envelope: String,
    confirmInsecureHttp: Boolean,
  ) {
    registerNewPayload(
      PairingPayloadCodec.decode(envelope),
      confirmInsecureHttp,
      refreshDuplicate = false,
    )
  }

  public suspend fun registerExternalCanary(
    envelope: String,
    expectation: ExternalCanaryExpectation,
    confirmInsecureHttp: Boolean,
  ) {
    externalCanaryExpectation = expectation
    registerNewPayload(
      PairingPayloadCodec.decode(envelope),
      confirmInsecureHttp,
      refreshDuplicate = true,
    )
  }

  public suspend fun registerManual(
    apiUri: URI,
    displayName: String,
    bearer: CharArray,
    tlsFingerprint: String?,
    confirmInsecureHttp: Boolean,
  ) {
    try {
      registerNewPayload(
        PairingPayload.create(apiUri, displayName, bearer, tlsFingerprint),
        confirmInsecureHttp,
        refreshDuplicate = false,
      )
    } finally {
      bearer.fill('\u0000')
    }
  }

  public suspend fun updateHost(
    hostId: HostId,
    apiUri: URI,
    displayName: String,
    tlsFingerprint: String?,
    confirmInsecureHttp: Boolean,
  ) {
    registry.updateMetadata(hostId, apiUri, displayName, tlsFingerprint, confirmInsecureHttp)
    afterHostMutation(hostId, HostManagementNotice.Updated(hostId))
  }

  public suspend fun replaceHost(
    hostId: HostId,
    apiUri: URI,
    displayName: String,
    bearer: CharArray,
    tlsFingerprint: String?,
    confirmInsecureHttp: Boolean,
  ) {
    try {
      replaceHostPayload(
        hostId,
        PairingPayload.create(apiUri, displayName, bearer, tlsFingerprint),
        confirmInsecureHttp,
      )
    } finally {
      bearer.fill('\u0000')
    }
  }

  public suspend fun replaceHostEnvelope(
    hostId: HostId,
    envelope: String,
    confirmInsecureHttp: Boolean,
  ) {
    replaceHostPayload(hostId, PairingPayloadCodec.decode(envelope), confirmInsecureHttp)
  }

  public fun clearHostManagementNotice() {
    mutableHostManagementState.value = mutableHostManagementState.value.copy(notice = null)
  }

  public fun reportHostManagementFailure(code: String) {
    mutableHostManagementState.value =
      mutableHostManagementState.value.copy(
        notice = HostManagementNotice.Failure(code.takeIf(INTERACTIVE_SAFE_CODE::matches) ?: "host_update_failed"),
      )
  }

  public suspend fun refresh() {
    val hosts = registry.list()
    publishRegisteredHosts(hosts)
    if (hosts.isEmpty()) {
      transport.replaceHosts(emptyList())
      mutableState.value = LiveReadonlyState.Unconfigured
      return
    }
    transport.replaceHosts(hosts)
    transport.prepareReadonlyRefresh()
    val priorReady = mutableState.value as? LiveReadonlyState.Ready
    val previous = priorReady?.hosts.orEmpty()
    val previousSelected = priorReady?.selectedHostId
    if (previous.isNotEmpty()) {
      mutableState.value =
        LiveReadonlyState.Ready(
          hosts =
            previous.map { snapshot ->
              snapshot.copy(
                session = snapshot.session?.let { SessionSurfaceReducer.withFreshness(it, CacheFreshness.RECONNECTING, 0) },
                rpcObserverConnected = false,
              )
            },
          selectedHostId =
            defaultHostId?.takeIf { id -> previous.any { it.host.id == id } }
              ?: previousSelected?.takeIf { id -> previous.any { it.host.id == id } }
              ?: previous.first().host.id,
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
              session = cached.session?.let { SessionSurfaceReducer.withFreshness(it, CacheFreshness.OFFLINE_CACHED, 0) },
              rpcObserverConnected = false,
            )
        }
      }
    }
    if (snapshots.isNotEmpty()) {
      mutableState.value =
        LiveReadonlyState.Ready(
          hosts = snapshots,
          selectedHostId =
            defaultHostId?.takeIf { id -> snapshots.any { it.host.id == id } }
              ?: previousSelected?.takeIf { id -> snapshots.any { it.host.id == id } }
              ?: snapshots.first().host.id,
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

  public suspend fun selectDefaultHost(hostId: HostId) {
    val hosts = registry.list()
    require(hosts.any { it.id == hostId }) { "host is not registered" }
    defaultHostStore.write(hostId)
    defaultHostId = hostId
    publishRegisteredHosts(hosts)
    selectHost(hostId)
  }

  public suspend fun selectSession(inventoryId: String) {
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: throw LiveReadonlyFailure("session_catalog_unavailable")
    val selectedHost = ready.selected
    if (selectedHost.catalog.items.none { it.inventoryId == inventoryId }) {
      throw LiveReadonlyFailure("inventory_session_unavailable")
    }
    dailyDriverStore.writeSelectedInventory(selectedHost.host.id, inventoryId)
    if (activeInteractive?.hostId == selectedHost.host.id) closeActiveInteractive()
    refresh()
  }

  public suspend fun createConfiguredSession(name: String?) {
    requireNoPendingSessionAction()
    val (host, lifecycle) = selectedLifecycle()
    val normalizedName = name?.trim()?.takeIf(String::isNotEmpty)
    val request = DurableRequestIdentity("android-create-${UUID.randomUUID()}", "android-create-once-${UUID.randomUUID()}")
    val prepared =
      LiveSessionActionBookmark(
        hostId = host.id,
        kind = LiveSessionActionKind.CREATE,
        endpoint = LiveSessionActionEndpoint.SESSION_TICKET,
        requestId = request.requestId,
        idempotencyKey = request.idempotencyKey,
        inventoryId = null,
        ticketId = null,
      )
    dailyDriverStore.writeActionBookmark(prepared)
    mutableSessionActionState.value = LiveSessionActionState.Working(LiveSessionActionKind.CREATE)
    try {
      withClient(host) { client ->
        when (val result = client.createConfiguredSession(lifecycle.capabilities, request, name = normalizedName)) {
          is ApiResult.Failure -> {
            dailyDriverStore.writeActionBookmark(null)
            mutableSessionActionState.value =
              LiveSessionActionState.Failure(LiveSessionActionKind.CREATE, safeActionCode(result.error.code), result.error.retryable)
          }

          is ApiResult.Success -> {
            val accepted = prepared.copy(ticketId = result.value.ticketId)
            dailyDriverStore.writeActionBookmark(accepted)
            publishSessionTicket(accepted, result.value.state, result.value.sessionId, result.value.generation, result.value.error?.code)
          }
        }
      }
    } catch (_: CancellationException) {
      throw CancellationException()
    } catch (_: Throwable) {
      mutableSessionActionState.value = LiveSessionActionState.Indeterminate(prepared)
    }
  }

  public suspend fun adoptSession(inventoryId: String) {
    requireNoPendingSessionAction()
    val (host, lifecycle) = selectedLifecycle()
    val record = lifecycle.records[inventoryId] ?: throw LiveReadonlyFailure("inventory_session_unavailable")
    if (record.managed != null) {
      mutableSessionActionState.value = LiveSessionActionState.Working(LiveSessionActionKind.ADOPT)
      withClient(host) { client ->
        when (val result = client.adoptExisting(record)) {
          is ApiResult.Failure -> {
            mutableSessionActionState.value =
              LiveSessionActionState.Failure(LiveSessionActionKind.ADOPT, safeActionCode(result.error.code), result.error.retryable)
          }

          is ApiResult.Success -> {
            val adopted = result.value
            dailyDriverStore.writeSelectedInventory(host.id, adopted.inventoryId)
            refresh()
            mutableSessionActionState.value = LiveSessionActionState.Completed(LiveSessionActionKind.ADOPT, adopted.session.key)
          }
        }
      }
      return
    }
    if (!record.activation.eligible || DashboardActivationMode.REUSE !in record.activation.modes) {
      throw LiveReadonlyFailure(record.activation.reasonCode?.let(::safeActionCode) ?: "reuse_activation_unavailable")
    }
    val request = DurableRequestIdentity("android-adopt-${UUID.randomUUID()}", "android-adopt-once-${UUID.randomUUID()}")
    val prepared =
      LiveSessionActionBookmark(
        hostId = host.id,
        kind = LiveSessionActionKind.ADOPT,
        endpoint = LiveSessionActionEndpoint.ACTIVATION_TICKET,
        requestId = request.requestId,
        idempotencyKey = request.idempotencyKey,
        inventoryId = inventoryId,
        ticketId = null,
      )
    val info = withClient(host) { client -> client.inventoryInfo(inventoryId).successOrThrow().value }
    dailyDriverStore.writeActionBookmark(prepared)
    mutableSessionActionState.value = LiveSessionActionState.Working(LiveSessionActionKind.ADOPT)
    try {
      withClient(host) { client ->
        when (val result = client.activateForReuse(record, request, info.sourceFingerprint)) {
          is ApiResult.Failure -> {
            dailyDriverStore.writeActionBookmark(null)
            mutableSessionActionState.value =
              LiveSessionActionState.Failure(LiveSessionActionKind.ADOPT, safeActionCode(result.error.code), result.error.retryable)
          }

          is ApiResult.Success -> {
            val accepted = prepared.copy(ticketId = result.value.ticketId)
            dailyDriverStore.writeActionBookmark(accepted)
            publishActivationTicket(accepted, result.value.state, result.value.managedSession, result.value.error?.code)
          }
        }
      }
    } catch (_: CancellationException) {
      throw CancellationException()
    } catch (_: Throwable) {
      mutableSessionActionState.value = LiveSessionActionState.Indeterminate(prepared)
    }
  }

  public suspend fun refreshSessionAction() {
    val bookmark =
      dailyDriverStore.readActionBookmark() ?: run {
        mutableSessionActionState.value = LiveSessionActionState.Idle
        return
      }
    val ticketId =
      bookmark.ticketId ?: run {
        mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
        return
      }
    val host =
      registry.list().firstOrNull { it.id == bookmark.hostId } ?: run {
        mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
        return
      }
    try {
      withClient(host) { client ->
        when (bookmark.endpoint) {
          LiveSessionActionEndpoint.SESSION_TICKET -> {
            when (val result = client.ticket(ticketId)) {
              is ApiResult.Failure -> {
                mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
              }

              is ApiResult.Success -> {
                publishSessionTicket(
                  bookmark,
                  result.value.state,
                  result.value.sessionId,
                  result.value.generation,
                  result.value.error?.code,
                )
              }
            }
          }

          LiveSessionActionEndpoint.ACTIVATION_TICKET -> {
            when (val result = client.activation(ticketId)) {
              is ApiResult.Failure -> {
                mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
              }

              is ApiResult.Success -> {
                publishActivationTicket(bookmark, result.value.state, result.value.managedSession, result.value.error?.code)
              }
            }
          }
        }
      }
    } catch (_: CancellationException) {
      throw CancellationException()
    } catch (_: Throwable) {
      mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
    }
  }

  public suspend fun clearSessionAction() {
    when (mutableSessionActionState.value) {
      LiveSessionActionState.Idle,
      is LiveSessionActionState.Completed,
      is LiveSessionActionState.Failure,
      -> {
        dailyDriverStore.writeActionBookmark(null)
        mutableSessionActionState.value = LiveSessionActionState.Idle
      }

      else -> {}
    }
  }

  public suspend fun removeHost(hostId: HostId) {
    val current = registry.list().singleOrNull { it.id == hostId } ?: return
    registry.remove(hostId)
    if (activeInteractive?.hostId == hostId) closeActiveInteractive()
    transport.invalidateHost(hostId)
    val remaining = registry.list()
    if (defaultHostId == hostId) {
      defaultHostId = remaining.firstOrNull()?.id
      defaultHostStore.write(defaultHostId)
    }
    publishRegisteredHosts(remaining, HostManagementNotice.Forgotten(current.displayName))
    refresh()
  }

  private suspend fun registerNewPayload(
    payload: PairingPayload,
    confirmInsecureHttp: Boolean,
    refreshDuplicate: Boolean,
  ) {
    val existing = registry.list().firstOrNull { it.baseUri == payload.apiUri }
    if (existing != null) {
      payload.close()
      publishRegisteredHosts(registry.list(), HostManagementNotice.DuplicateEndpoint(existing.id))
      if (refreshDuplicate) refresh()
      return
    }
    val registered = registry.register(payload, confirmInsecureHttp)
    if (defaultHostId == null) {
      defaultHostId = registered.id
      defaultHostStore.write(defaultHostId)
    }
    publishRegisteredHosts(registry.list(), HostManagementNotice.Added(registered.id))
    refresh()
  }

  private suspend fun replaceHostPayload(
    hostId: HostId,
    payload: PairingPayload,
    confirmInsecureHttp: Boolean,
  ) {
    registry.replace(hostId, payload, confirmInsecureHttp)
    afterHostMutation(hostId, HostManagementNotice.Repaired(hostId))
  }

  private suspend fun afterHostMutation(
    hostId: HostId,
    notice: HostManagementNotice,
  ) {
    if (activeInteractive?.hostId == hostId) closeActiveInteractive()
    transport.invalidateHost(hostId)
    publishRegisteredHosts(registry.list(), notice)
    refresh()
  }

  private fun publishRegisteredHosts(
    hosts: List<RegisteredHost>,
    notice: HostManagementNotice? = mutableHostManagementState.value.notice,
  ) {
    mutableHostManagementState.value =
      HostManagementState(
        hosts = hosts.sortedBy { it.displayName.lowercase() },
        defaultHostId = defaultHostId,
        notice = notice,
      )
  }

  private suspend fun restoreInteractiveResume() {
    val encoded = dailyDriverStore.readInteractiveResume() ?: return
    val resumed =
      runCatching { SessionResumeSnapshotCodec.decode(encoded) }
        .getOrElse {
          dailyDriverStore.writeInteractiveResume(null)
          return
        }
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: return
    val host =
      ready.hosts.firstOrNull { it.host.id == resumed.hostId } ?: run {
        dailyDriverStore.writeInteractiveResume(null)
        return
      }
    val surface = host.session ?: return
    if (
      surface.session.sessionId != resumed.session.sessionId ||
      surface.session.generation != resumed.session.generation ||
      surface.host.authority.hostInstanceId != resumed.hostInstanceId
    ) {
      return
    }
    val lifecycle =
      runCatching { SessionLifecycleCoordinator.restore(resumed, host.interactiveCommands) }
        .getOrElse {
          dailyDriverStore.writeInteractiveResume(null)
          return
        }
    val machine =
      LiveInteractiveSessionMachine(
        session = resumed.session,
        supportedCommands = host.interactiveCommands,
        authority = surface.host.authority,
        modelLabel = surface.session.modelLabel ?: "default model",
        thinkingLevel = surface.session.thinkingLevel ?: "default",
        restoredReceipts = lifecycle.snapshot().commands.map(::liveReceipt),
      )
    mutableInteractiveState.value =
      LiveInteractiveAppState.Failure(
        hostId = resumed.hostId,
        sessionId = resumed.session.sessionId,
        generation = resumed.session.generation,
        code = "process_restored_reconnect_required",
        lastSnapshot = machine.snapshot,
      )
  }

  private suspend fun restoreSessionAction() {
    if (dailyDriverStore.readActionBookmark() != null) refreshSessionAction()
  }

  private suspend fun requireNoPendingSessionAction() {
    val bookmark = dailyDriverStore.readActionBookmark() ?: return
    mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
    throw CommandAdmissionException("pending_session_action", "an earlier session mutation still requires reconciliation")
  }

  private suspend fun publishSessionTicket(
    bookmark: LiveSessionActionBookmark,
    state: TicketState,
    sessionId: String?,
    generation: Int?,
    errorCode: String?,
  ) {
    val session = sessionId?.let { id -> generation?.let { SessionKey(id, it) } }
    when (state) {
      TicketState.QUEUED,
      TicketState.RUNNING,
      -> {
        mutableSessionActionState.value = LiveSessionActionState.Accepted(bookmark, state, session)
      }

      TicketState.INDETERMINATE -> {
        mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
      }

      TicketState.FAILED -> {
        dailyDriverStore.writeActionBookmark(null)
        mutableSessionActionState.value =
          LiveSessionActionState.Failure(bookmark.kind, errorCode?.let(::safeActionCode) ?: "session_create_failed", false)
      }

      TicketState.SUCCEEDED -> {
        finishSessionAction(bookmark, session)
      }
    }
  }

  private suspend fun publishActivationTicket(
    bookmark: LiveSessionActionBookmark,
    state: TicketState,
    session: SessionKey?,
    errorCode: String?,
  ) {
    when (state) {
      TicketState.QUEUED,
      TicketState.RUNNING,
      -> {
        mutableSessionActionState.value = LiveSessionActionState.Accepted(bookmark, state, session)
      }

      TicketState.INDETERMINATE -> {
        mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
      }

      TicketState.FAILED -> {
        dailyDriverStore.writeActionBookmark(null)
        mutableSessionActionState.value =
          LiveSessionActionState.Failure(bookmark.kind, errorCode?.let(::safeActionCode) ?: "session_adoption_failed", false)
      }

      TicketState.SUCCEEDED -> {
        finishSessionAction(bookmark, session)
      }
    }
  }

  private suspend fun finishSessionAction(
    bookmark: LiveSessionActionBookmark,
    session: SessionKey?,
  ) {
    if (session == null) {
      mutableSessionActionState.value = LiveSessionActionState.Indeterminate(bookmark)
      return
    }
    dailyDriverStore.writeActionBookmark(null)
    refresh()
    val host = (mutableState.value as? LiveReadonlyState.Ready)?.hosts?.firstOrNull { it.host.id == bookmark.hostId }
    val matching = host?.catalog?.items?.firstOrNull { it.managedSession == session }
    if (matching != null) {
      dailyDriverStore.writeSelectedInventory(bookmark.hostId, matching.inventoryId)
      refresh()
    }
    mutableSessionActionState.value = LiveSessionActionState.Completed(bookmark.kind, session)
  }

  private fun selectedLifecycle(): Pair<RegisteredHost, HostLifecycleData> {
    val ready = mutableState.value as? LiveReadonlyState.Ready ?: throw LiveReadonlyFailure("session_catalog_unavailable")
    val selectedHost = ready.selected.host
    return selectedHost to (lifecycleByHost[selectedHost.id] ?: throw LiveReadonlyFailure("session_catalog_unavailable"))
  }

  private suspend fun loadLifecycleCoordinator(
    hostId: HostId,
    hostInstanceId: String?,
    session: SessionKey,
    supportedCommands: Set<PiRpcCommandType>,
  ): SessionLifecycleCoordinator {
    val restored =
      dailyDriverStore.readInteractiveResume()?.let { encoded ->
        runCatching { SessionResumeSnapshotCodec.decode(encoded) }
          .getOrElse {
            dailyDriverStore.writeInteractiveResume(null)
            null
          }
      }
    if (
      restored != null &&
      restored.hostId == hostId &&
      restored.hostInstanceId == hostInstanceId &&
      restored.session == session
    ) {
      return runCatching { SessionLifecycleCoordinator.restore(restored, supportedCommands) }
        .getOrElse {
          dailyDriverStore.writeInteractiveResume(null)
          SessionLifecycleCoordinator.create(hostId, session, supportedCommands, hostInstanceId)
        }
    }
    if (restored != null) dailyDriverStore.writeInteractiveResume(null)
    return SessionLifecycleCoordinator.create(hostId, session, supportedCommands, hostInstanceId)
  }

  private suspend fun persistLifecycle(lifecycle: SessionLifecycleCoordinator) {
    dailyDriverStore.writeInteractiveResume(SessionResumeSnapshotCodec.encode(lifecycle.snapshot()))
  }

  private suspend fun <T> withClient(
    host: RegisteredHost,
    block: suspend (PiDaemonClient) -> T,
  ): T =
    credentials.withBearerSuspending(host.credential) { bearer ->
      val descriptor = PiDaemonHostDescriptor(host.id, host.displayName, host.baseUri)
      ServiceBearerRequestFactory
        .create(
          host = descriptor,
          bearer = bearer,
          allowInsecureHttp = host.transportSecurity != TransportSecurity.HTTPS,
        ).use { factory -> block(PiDaemonClient(descriptor, factory, transport)) }
    }

  private fun catalogOf(
    inventory: DashboardInventoryPage,
    retainedSessionCount: Int,
    selectedInventoryId: String?,
    capabilities: DashboardCapabilities,
  ): LiveSessionCatalog =
    LiveSessionCatalog(
      items =
        inventory.sessions.map { record ->
          LiveSessionCatalogItem(
            inventoryId = record.inventoryId,
            title = record.title,
            projectLabel = record.projectLabel,
            cwdBasename = record.cwdBasename,
            managedSession = record.managed?.key,
            state = record.managed?.state ?: record.presence.runtime,
            unread = record.presence.unread,
            activityAt = record.activityAt,
            canAdopt = record.managed != null || (record.activation.eligible && DashboardActivationMode.REUSE in record.activation.modes),
            adoptionReasonCode = record.activation.reasonCode,
          )
        },
      selectedInventoryId = selectedInventoryId,
      createDefaults = capabilities.configuredSessionDefaults?.toLiveDefaults(),
      inventoryStale = inventory.index.stale,
      inventoryReconciling = inventory.index.reconciling,
      retainedSessionCount = retainedSessionCount,
    )

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
        submitInteractive(active, active.machine.prepare(action, correlationId))
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
    val lifecycleText = active.lifecycle.requestControl(active.attemptId).text
    val machineText = active.machine.requestControl()
    requireMatchingOutbound(lifecycleText, machineText)
    sendOnce(active, machineText)
  }

  public suspend fun releaseControl() {
    val active = requireActiveInteractive()
    val lifecycleText = active.lifecycle.releaseControl(active.attemptId).text
    val machineText = active.machine.releaseControl()
    requireMatchingOutbound(lifecycleText, machineText)
    sendOnce(active, machineText)
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
    val selectedSession = selected.session ?: throw LiveReadonlyFailure("interactive_session_unavailable")
    if (selectedSession.host.freshness != CacheFreshness.FRESH) {
      throw LiveReadonlyFailure("interactive_freshness_required")
    }
    val sessionId = selectedSession.session.sessionId ?: throw LiveReadonlyFailure("interactive_session_unavailable")
    val generation = selectedSession.session.generation ?: throw LiveReadonlyFailure("interactive_session_unavailable")
    activeInteractive
      ?.takeIf {
        it.hostId == selected.host.id &&
          it.authority == selectedSession.host.authority &&
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
              val session = SessionKey(sessionId, generation)
              val lifecycle =
                loadLifecycleCoordinator(
                  hostId = selected.host.id,
                  hostInstanceId = selectedSession.host.authority.hostInstanceId,
                  session = session,
                  supportedCommands = selected.interactiveCommands,
                )
              val machine =
                LiveInteractiveSessionMachine(
                  session = session,
                  supportedCommands = selected.interactiveCommands,
                  authority = selectedSession.host.authority,
                  modelLabel = selectedSession.session.modelLabel ?: "default model",
                  thinkingLevel = selectedSession.session.thinkingLevel ?: "default",
                  restoredReceipts = lifecycle.snapshot().commands.map(::liveReceipt),
                )
              val attemptId = ConnectionAttemptId("android-${UUID.randomUUID()}")
              val directive = lifecycle.beginConnection(attemptId)
              persistLifecycle(lifecycle)
              val rpcSocket =
                attachStage("observer_connect_failed") {
                  client.attach(directive.session, directive.role, directive.cursor)
                }
              try {
                val first =
                  attachStage("observer_connect_failed") {
                    withTimeout(10_000) { rpcSocket.incomingText.first() }
                  }
                val disposition = lifecycle.onFrame(attemptId, SessionRpcFrameCodec.decode(first))
                persistLifecycle(lifecycle)
                if (disposition != IncomingFrameDisposition.APPLIED) {
                  throw LiveReadonlyFailure("interactive_resync_required")
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
                OpenedInteractive(machine, lifecycle, attemptId, rpcSocket, tuiMachine, tuiSocket)
              } catch (error: Throwable) {
                lifecycle.onDisconnect(attemptId)
                persistLifecycle(lifecycle)
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
        authority = selectedSession.host.authority,
        machine = opened.machine,
        lifecycle = opened.lifecycle,
        attemptId = opened.attemptId,
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
            val disposition = active.lifecycle.onFrame(active.attemptId, SessionRpcFrameCodec.decode(text))
            persistLifecycle(active.lifecycle)
            if (disposition != IncomingFrameDisposition.APPLIED) {
              throw LiveReadonlyFailure("interactive_resync_required")
            }
            val wasController = active.machine.snapshot.role == InteractiveControllerRole.CONTROLLER
            active.machine.accept(text)
            publishInteractive(active)
            if (!wasController && active.machine.snapshot.role == InteractiveControllerRole.CONTROLLER &&
              active.machine.snapshot.tree == null
            ) {
              submitInteractive(active, active.machine.prepareTree("tree-${UUID.randomUUID()}"))
            }
          }
        } catch (_: Throwable) {
          // The finally block converts every missing acknowledgement to indeterminate.
        } finally {
          active.lifecycle.onDisconnect(active.attemptId)
          persistLifecycle(active.lifecycle)
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
    val selectedSession = selected.session
    if (
      selected.host.id != active.hostId ||
      selectedSession == null ||
      selectedSession.host.authority != active.authority ||
      selectedSession.host.freshness != CacheFreshness.FRESH ||
      selectedSession.session.sessionId != active.session.sessionId ||
      selectedSession.session.generation != active.session.generation
    ) {
      active.machine.disconnected()
      publishInteractive(active, "interactive_freshness_required")
      throw LiveReadonlyFailure("interactive_freshness_required")
    }
    return active
  }

  private suspend fun submitInteractive(
    active: ActiveInteractive,
    prepared: PreparedLiveCommand,
  ) {
    val lifecycleText =
      active.lifecycle
        .submit(active.attemptId, prepared.intent, prepared.correlationId)
        .text
    requireMatchingOutbound(lifecycleText, prepared.text)
    persistLifecycle(active.lifecycle)
    sendOnce(active, prepared.text)
  }

  private suspend fun sendOnce(
    active: ActiveInteractive,
    text: String,
  ) {
    try {
      active.rpcSocket.sendText(text)
      publishInteractive(active)
    } catch (error: CancellationException) {
      throw error
    } catch (_: Throwable) {
      active.lifecycle.onDisconnect(active.attemptId)
      persistLifecycle(active.lifecycle)
      active.machine.disconnected()
      publishInteractive(active, "interactive_send_indeterminate")
      throw LiveReadonlyFailure("interactive_send_indeterminate")
    }
  }

  private fun requireMatchingOutbound(
    lifecycleText: String,
    machineText: String,
  ) {
    if (lifecycleText != machineText) throw LiveReadonlyFailure("interactive_lifecycle_mismatch")
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
    active.lifecycle.onDisconnect(active.attemptId)
    persistLifecycle(active.lifecycle)
    runCatching { active.rpcSocket.close() }
    runCatching { active.tuiSocket.close() }
    mutableInteractiveState.value = LiveInteractiveAppState.Inactive
  }

  private suspend fun refreshHost(
    host: RegisteredHost,
    previous: LiveHostSession?,
  ): LiveHostSession =
    withClient(host) { client ->
      val hostCapabilities = client.capabilities().successOrThrow()
      val dashboardCapabilities = client.dashboardCapabilities().successOrThrow()
      if (hostCapabilities.hostInstanceId != dashboardCapabilities.hostInstanceId) {
        throw LiveReadonlyFailure("host_identity_changed")
      }
      val hostInstanceId = hostCapabilities.hostInstanceId
      previous?.session?.let { previousSession ->
        if (previousSession.host.authority.hostInstanceId != hostInstanceId) {
          mutableState.value =
            LiveReadonlyState.Ready(
              hosts =
                listOf(
                  previous.copy(
                    session = SessionSurfaceReducer.withFreshness(previousSession, CacheFreshness.RESYNCING, 0),
                    rpcObserverConnected = false,
                  ),
                ),
              selectedHostId = host.id,
            )
        }
      }

      val expectation = externalCanaryExpectation
      if (expectation != null && hostInstanceId != expectation.hostInstanceId) {
        throw LiveReadonlyFailure("external_canary_host_changed")
      }
      val retained = client.listSessions(limit = 50).successOrThrow()
      val inventory = client.listInventory(limit = 50).successOrThrow()
      val requestedInventoryId =
        expectation?.inventoryId
          ?: dailyDriverStore.readSelectedInventory(host.id)
          ?: previous?.catalog?.selectedInventoryId
      val selected =
        requestedInventoryId?.let { id -> inventory.value.sessions.firstOrNull { it.inventoryId == id } }
          ?: if (expectation == null) inventory.value.sessions.firstOrNull() else null
      if (expectation != null && selected == null) {
        throw LiveReadonlyFailure("external_canary_session_changed")
      }
      if (selected?.inventoryId != requestedInventoryId) {
        dailyDriverStore.writeSelectedInventory(host.id, selected?.inventoryId)
      }

      val catalog = catalogOf(inventory.value, retained.value.sessions.size, selected?.inventoryId, dashboardCapabilities.value)
      val lifecycle =
        HostLifecycleData(
          host = host,
          capabilities = dashboardCapabilities.value,
          inventory = inventory.value,
          records = inventory.value.sessions.associateBy(DashboardInventoryRecord::inventoryId),
        )
      lifecycleByHost[host.id] = lifecycle
      if (selected == null) {
        return@withClient LiveHostSession(
          host = host,
          session = null,
          catalog = catalog,
          rpcObserverConnected = false,
          rpcObserverEligible = false,
          interactiveCommands = InteractiveCapabilities.from(hostCapabilities.value).commands,
        )
      }

      val info = client.inventoryInfo(selected.inventoryId).successOrThrow()
      val transcript =
        client
          .transcript(selected.inventoryId, limit = 50, expectedFingerprint = info.value.sourceFingerprint)
          .successOrThrow()
      if (info.hostInstanceId != hostInstanceId || transcript.hostInstanceId != hostInstanceId) {
        throw LiveReadonlyFailure("host_identity_changed")
      }
      val managed = selected.managed
      val observerSafe =
        managed != null &&
          managed.state == "idle" &&
          managed.recovery == null &&
          selected.presence.runtime == "resident-idle" &&
          transcript.value.observerSession == managed.key
      if (expectation?.observerAttachAllowed == true && !observerSafe) {
        throw LiveReadonlyFailure("external_canary_session_unsafe")
      }
      val observerEligible = observerSafe && expectation?.observerAttachAllowed != false
      val authority = HostAuthority(host.id, host.bearerGeneration, hostInstanceId)
      val session =
        SessionLifecycleProjection.project(
          host = SessionHostContext(host.id, host.displayName, authority, CacheFreshness.FRESH, 0),
          inventory = inventory.value,
          info = info.value,
          transcript = transcript.value,
        )
      val rpcConnected =
        if (observerEligible && hostCapabilities.value.rpcSubprotocols.contains("pi-daemon-rpc.v1")) {
          runCatching {
            val socket = client.attachObserver(transcript.value)
            try {
              val ready = withTimeout(10_000) { SessionRpcFrameCodec.decode(socket.incomingText.first()) }
              ready is SessionRpcFrame.AttachReady &&
                ready.role == SessionRole.OBSERVER &&
                ready.hostInstanceId == hostInstanceId &&
                ready.sessionId == transcript.value.observerSession?.sessionId &&
                ready.generation == transcript.value.observerSession?.generation
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
        catalog = catalog,
        rpcObserverConnected = rpcConnected,
        rpcObserverEligible = observerEligible,
        interactiveCommands = InteractiveCapabilities.from(hostCapabilities.value).commands,
      )
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

private data class HostLifecycleData(
  val host: RegisteredHost,
  val capabilities: DashboardCapabilities,
  val inventory: DashboardInventoryPage,
  val records: Map<String, DashboardInventoryRecord>,
)

private fun ConfiguredSessionDefaults.toLiveDefaults(): LiveCreateSessionDefaults {
  val provider = (model?.get("provider") as? JsonPrimitive)?.contentOrNull
  val modelId = (model?.get("id") as? JsonPrimitive)?.contentOrNull
  val thinkingLevel = (model?.get("thinkingLevel") as? JsonPrimitive)?.contentOrNull
  val toolMode = (tools["mode"] as? JsonPrimitive)?.contentOrNull ?: "restricted"
  val projectTrust = (resources["projectTrust"] as? JsonPrimitive)?.contentOrNull ?: "default"
  return LiveCreateSessionDefaults(
    cwd = cwd,
    persistence = persistence,
    provider = provider,
    modelId = modelId,
    thinkingLevel = thinkingLevel,
    toolMode = toolMode,
    projectTrust = projectTrust,
    authoritySource = authoritySource,
  )
}

private fun <T> ApiResult<T>.successOrThrow(): ApiResult.Success<T> =
  when (this) {
    is ApiResult.Success -> this
    is ApiResult.Failure -> throw LiveReadonlyFailure(safeActionCode(error.code))
  }

private val SESSION_ACTION_CODE = Regex("^[a-z][a-z0-9_]{0,127}$")

private fun safeActionCode(value: String): String = value.takeIf(SESSION_ACTION_CODE::matches) ?: "session_action_failed"

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
  val lifecycle: SessionLifecycleCoordinator,
  val attemptId: ConnectionAttemptId,
  val rpcSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
  val tuiMachine: LiveTuiSessionMachine,
  val tuiSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
)

private data class ActiveInteractive(
  val hostId: HostId,
  val session: SessionKey,
  val authority: HostAuthority,
  val machine: LiveInteractiveSessionMachine,
  val lifecycle: SessionLifecycleCoordinator,
  val attemptId: ConnectionAttemptId,
  val rpcSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
  val tuiMachine: LiveTuiSessionMachine,
  val tuiSocket: com.harryaskham.pidroid.sdk.core.PiDaemonSocket,
  var rpcJob: Job? = null,
  var tuiJob: Job? = null,
)

private fun liveReceipt(command: ResumableCommand): LiveCommandReceipt =
  LiveCommandReceipt(command.correlationId.value, command.kind, command.lifecycle)

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
