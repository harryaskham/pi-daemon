package com.harryaskham.pidroid.live

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.SessionRole
import com.harryaskham.pidroid.sessionui.InteractionContext
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import com.harryaskham.pidroid.sessionui.RichInteractiveSessionSurface
import com.harryaskham.pidroid.sessionui.SessionSurface
import com.harryaskham.pidroid.sessionui.SessionSurfaceChrome
import com.harryaskham.pidroid.sessionui.SessionSurfaceLayout
import com.harryaskham.pidroid.sessionui.SessionTreeSurface
import com.harryaskham.pidroid.sessionui.TuiSurface
import com.harryaskham.pidroid.sessionui.TuiSurfaceLayout
import com.harryaskham.pidroid.workspace.PiDroidDailyDriverAdaptivePolicy
import com.harryaskham.pidroid.workspace.PiDroidDestination
import com.harryaskham.pidroid.workspace.PiDroidDestinationBar
import com.harryaskham.pidroid.workspace.PiDroidEmptyState
import com.harryaskham.pidroid.workspace.PiDroidErrorState
import com.harryaskham.pidroid.workspace.PiDroidLoadingState
import com.harryaskham.pidroid.workspace.PiDroidRelativeActivity
import com.harryaskham.pidroid.workspace.PiDroidSectionTitle
import com.harryaskham.pidroid.workspace.PiDroidSessionFilter
import com.harryaskham.pidroid.workspace.PiDroidSessionInventory
import com.harryaskham.pidroid.workspace.PiDroidSessionSummary
import com.harryaskham.pidroid.workspace.PiDroidStatusChip
import com.harryaskham.pidroid.workspace.PiDroidStatusTone
import java.time.Instant

private val CanaryCanvas = Color(0xFF0C111B)
private val CanaryPrimary = Color(0xFFE8EEF7)
private val CanaryMuted = Color(0xFF91A0B7)
private val CanaryAccent = Color(0xFF82D2E5)
private val CanaryGreen = Color(0xFFA8D8A0)
private val CanaryWarning = Color(0xFFE7C987)

@Composable
public fun LiveReadonlyScreen(
  state: LiveReadonlyState,
  interaction: LiveInteractiveAppState,
  hostManagement: HostManagementState,
  sessionAction: LiveSessionActionState,
  externalCanaryMode: Boolean,
  backgroundMonitoring: Boolean,
  onRegisterManual: (String, String, CharArray, String?, Boolean) -> Unit,
  onRegisterEnvelope: (String, Boolean) -> Unit,
  onRefresh: () -> Unit,
  onUpdateHost: (HostId, String, String, String?, Boolean) -> Unit,
  onReplaceHost: (HostId, String, String, CharArray, String?, Boolean) -> Unit,
  onReplaceHostEnvelope: (HostId, String, Boolean) -> Unit,
  onForgetHost: (HostId) -> Unit,
  onClearHostManagementNotice: () -> Unit,
  onSelectHost: (HostId) -> Unit,
  onSelectSession: (String) -> Unit,
  onCreateSession: (String?) -> Unit,
  onAdoptSession: (String) -> Unit,
  onRefreshSessionAction: () -> Unit,
  onClearSessionAction: () -> Unit,
  onStartBackgroundMonitoring: () -> Unit,
  onStopBackgroundMonitoring: () -> Unit,
  onConnectInteractive: () -> Unit,
  onInteractiveAction: (RichInteractionAction) -> Unit,
  onReconnectInteractive: () -> Unit,
) {
  var showHostManagement by rememberSaveable { mutableStateOf(state == LiveReadonlyState.Unconfigured) }
  LaunchedEffect(hostManagement.notice) {
    if (hostManagement.notice is HostManagementNotice.DuplicateEndpoint) showHostManagement = true
  }
  Surface(
    modifier =
      if (externalCanaryMode) {
        Modifier.fillMaxSize()
      } else {
        Modifier.fillMaxSize().safeDrawingPadding().imePadding()
      },
    color = if (externalCanaryMode) CanaryCanvas else MaterialTheme.colorScheme.background,
  ) {
    if (externalCanaryMode) {
      ExternalCanaryScreen(state)
      return@Surface
    }
    if (showHostManagement || hostManagement.hosts.isEmpty()) {
      HostManagementScreen(
        state = hostManagement,
        liveState = state,
        onClose = { showHostManagement = false },
        onRegisterManual = onRegisterManual,
        onRegisterEnvelope = onRegisterEnvelope,
        onUpdateHost = onUpdateHost,
        onReplaceHost = onReplaceHost,
        onReplaceHostEnvelope = onReplaceHostEnvelope,
        onForgetHost = onForgetHost,
        onSelectDefault = onSelectHost,
        onClearNotice = onClearHostManagementNotice,
      )
      return@Surface
    }
    when (state) {
      LiveReadonlyState.Unconfigured -> {
        StatusScreen(
          title = "Choose a host",
          detail = "No active host is configured.",
          onRefresh = onRefresh,
          onManageHosts = { showHostManagement = true },
        )
      }

      is LiveReadonlyState.Loading -> {
        Column(
          modifier = Modifier.fillMaxSize().padding(20.dp),
          verticalArrangement = Arrangement.Center,
        ) {
          PiDroidLoadingState("Connecting to the selected host")
          Row(
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
          ) {
            OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onRefresh) { Text("Retry") }
            OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = { showHostManagement = true }) { Text("Hosts") }
          }
        }
      }

      is LiveReadonlyState.Failure -> {
        StatusScreen(
          title = "Host unavailable",
          detail = "Connection failed safely · ${state.code.take(96)}",
          onRefresh = onRefresh,
          onManageHosts = { showHostManagement = true },
        )
      }

      is LiveReadonlyState.Ready -> {
        LiveSessionScreen(
          ready = state,
          interaction = interaction,
          onRefresh = onRefresh,
          onManageHosts = { showHostManagement = true },
          onSelectHost = onSelectHost,
          onSelectSession = onSelectSession,
          onCreateSession = onCreateSession,
          onAdoptSession = onAdoptSession,
          sessionAction = sessionAction,
          onRefreshSessionAction = onRefreshSessionAction,
          onClearSessionAction = onClearSessionAction,
          backgroundMonitoring = backgroundMonitoring,
          onStartBackgroundMonitoring = onStartBackgroundMonitoring,
          onStopBackgroundMonitoring = onStopBackgroundMonitoring,
          onConnectInteractive = onConnectInteractive,
          onInteractiveAction = onInteractiveAction,
          onReconnectInteractive = onReconnectInteractive,
        )
      }
    }
  }
}

@Composable
private fun ExternalCanaryScreen(state: LiveReadonlyState) {
  Column(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text("PI DROID", color = CanaryAccent, fontWeight = FontWeight.Black)
    Text("EXTERNAL CANARY · READONLY", color = CanaryPrimary, style = MaterialTheme.typography.headlineMedium)
    Text(
      "Content-free physical proof. No create, update, delete, prompt, control, or restart action is available.",
      color = CanaryMuted,
    )
    when (state) {
      LiveReadonlyState.Unconfigured -> {
        Text("PAIRING · PENDING", color = CanaryWarning, fontWeight = FontWeight.Bold)
      }

      is LiveReadonlyState.Loading -> {
        Text("READINESS · CHECKING", color = CanaryWarning, fontWeight = FontWeight.Bold)
      }

      is LiveReadonlyState.Failure -> {
        Text("CANARY · FAILED · ${state.code.uppercase()}", color = CanaryWarning, fontWeight = FontWeight.Bold)
      }

      is LiveReadonlyState.Ready -> {
        val selected = state.selected
        val fresh = selected.session?.host?.freshness == CacheFreshness.FRESH
        Text("HOST LISTING · VERIFIED", color = CanaryGreen, fontWeight = FontWeight.Bold)
        Text(
          if (fresh) "READINESS · READY" else "READINESS · NOT FRESH",
          color = if (fresh) CanaryGreen else CanaryWarning,
          fontWeight = FontWeight.Bold,
        )
        Text(
          if (fresh) "READONLY HYDRATION · VERIFIED" else "READONLY HYDRATION · NOT VERIFIED",
          color = if (fresh) CanaryGreen else CanaryWarning,
          fontWeight = FontWeight.Bold,
        )
        Text(
          when {
            selected.rpcObserverConnected -> "OBSERVER · ATTACHED TO IDLE SESSION"
            selected.rpcObserverEligible -> "OBSERVER · ATTACH FAILED"
            else -> "OBSERVER · NOT REQUESTED"
          },
          color = if (selected.rpcObserverEligible && !selected.rpcObserverConnected) CanaryWarning else CanaryGreen,
          fontWeight = FontWeight.Bold,
        )
        Text("MUTATION SURFACE · ABSENT", color = CanaryGreen, fontWeight = FontWeight.Bold)
      }
    }
  }
}

internal fun liveInteractiveStatusLabel(
  interaction: LiveInteractiveAppState,
  selectedHostId: HostId,
  rpcObserverConnected: Boolean,
): String {
  val snapshot =
    when (interaction) {
      is LiveInteractiveAppState.Ready -> interaction.snapshot.takeIf { interaction.hostId == selectedHostId }
      is LiveInteractiveAppState.Failure -> interaction.lastSnapshot?.takeIf { interaction.hostId == selectedHostId }
      else -> null
    }
  return when {
    interaction is LiveInteractiveAppState.Connecting && interaction.hostId == selectedHostId -> {
      "ACTION RECEIVED · CONNECTING"
    }

    interaction is LiveInteractiveAppState.Failure && (interaction.hostId == null || interaction.hostId == selectedHostId) -> {
      "INTERACTIVE ERROR · PREFLIGHT_ERROR · ${interaction.code.uppercase()}"
    }

    snapshot?.role == InteractiveControllerRole.CONTROLLER -> {
      "CONTROLLER"
    }

    snapshot?.role == InteractiveControllerRole.OBSERVER &&
      snapshot.connection == InteractiveConnectionState.READY -> {
      "OBSERVER · READY"
    }

    snapshot?.role == InteractiveControllerRole.REQUESTING -> {
      "REQUESTING"
    }

    snapshot?.role == InteractiveControllerRole.LOST -> {
      "CONNECTION LOST"
    }

    snapshot?.role == InteractiveControllerRole.DENIED -> {
      "CONTROL DENIED"
    }

    snapshot != null -> {
      "OBSERVER"
    }

    rpcObserverConnected -> {
      "READONLY RPC ATTACHED"
    }

    else -> {
      "READONLY REST"
    }
  }
}

@Composable
private fun LiveSessionScreen(
  ready: LiveReadonlyState.Ready,
  interaction: LiveInteractiveAppState,
  onRefresh: () -> Unit,
  onManageHosts: () -> Unit,
  onSelectHost: (HostId) -> Unit,
  onSelectSession: (String) -> Unit,
  onCreateSession: (String?) -> Unit,
  onAdoptSession: (String) -> Unit,
  sessionAction: LiveSessionActionState,
  onRefreshSessionAction: () -> Unit,
  onClearSessionAction: () -> Unit,
  backgroundMonitoring: Boolean,
  onStartBackgroundMonitoring: () -> Unit,
  onStopBackgroundMonitoring: () -> Unit,
  onConnectInteractive: () -> Unit,
  onInteractiveAction: (RichInteractionAction) -> Unit,
  onReconnectInteractive: () -> Unit,
) {
  var destinationName by rememberSaveable(ready.selectedHostId.value) { mutableStateOf(PiDroidDestination.TRANSCRIPT.name) }
  val destination = PiDroidDestination.valueOf(destinationName)
  val active =
    (interaction as? LiveInteractiveAppState.Ready)
      ?.takeIf { it.hostId == ready.selectedHostId }
  val interactiveSnapshot =
    when (interaction) {
      is LiveInteractiveAppState.Ready -> interaction.snapshot.takeIf { interaction.hostId == ready.selectedHostId }
      is LiveInteractiveAppState.Failure -> interaction.lastSnapshot?.takeIf { interaction.hostId == ready.selectedHostId }
      else -> null
    }
  val statusLabel = liveInteractiveStatusLabel(interaction, ready.selectedHostId, ready.selected.rpcObserverConnected)
  val statusTone =
    when (interactiveSnapshot?.role) {
      InteractiveControllerRole.CONTROLLER -> PiDroidStatusTone.POSITIVE

      InteractiveControllerRole.LOST,
      InteractiveControllerRole.DENIED,
      -> PiDroidStatusTone.ERROR

      InteractiveControllerRole.REQUESTING -> PiDroidStatusTone.WARNING

      else -> if (interaction is LiveInteractiveAppState.Failure) PiDroidStatusTone.ERROR else PiDroidStatusTone.INFO
    }

  BoxWithConstraints(Modifier.fillMaxSize()) {
    val layout = PiDroidDailyDriverAdaptivePolicy.resolve(maxWidth.value.toInt(), LocalDensity.current.fontScale)
    Column(Modifier.fillMaxSize()) {
      LiveTopBar(
        ready = ready,
        statusLabel = statusLabel,
        statusTone = statusTone,
        backgroundMonitoring = backgroundMonitoring,
        onRefresh = onRefresh,
        onManageHosts = onManageHosts,
        onSelectHost = onSelectHost,
        onStartBackgroundMonitoring = onStartBackgroundMonitoring,
        onStopBackgroundMonitoring = onStopBackgroundMonitoring,
      )
      Row(
        modifier = Modifier.fillMaxSize().padding(layout.contentGutterDp.dp),
        horizontalArrangement = Arrangement.spacedBy(layout.contentGutterDp.dp),
      ) {
        if (layout.showPersistentSessionRail) {
          Surface(
            modifier = Modifier.width(layout.sessionRailWidthDp.dp).fillMaxHeight(),
            color = MaterialTheme.colorScheme.surface,
            shape = MaterialTheme.shapes.large,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
          ) {
            DailyDriverSessionCatalog(
              host = ready.selected,
              action = sessionAction,
              vertical = true,
              onSelect = onSelectSession,
              onAdopt = onAdoptSession,
              onCreate = onCreateSession,
              onRefreshAction = onRefreshSessionAction,
              onClearAction = onClearSessionAction,
            )
          }
        }
        Column(
          modifier = Modifier.weight(1f).fillMaxHeight(),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          if (!layout.showPersistentSessionRail) {
            DailyDriverSessionCatalog(
              host = ready.selected,
              action = sessionAction,
              vertical = false,
              onSelect = onSelectSession,
              onAdopt = onAdoptSession,
              onCreate = onCreateSession,
              onRefreshAction = onRefreshSessionAction,
              onClearAction = onClearSessionAction,
            )
          }
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            PiDroidDestinationBar(
              selected = destination,
              onSelect = { destinationName = it.name },
              modifier = Modifier.weight(1f),
            )
            if (interaction is LiveInteractiveAppState.Failure) {
              OutlinedButton(
                modifier =
                  Modifier
                    .heightIn(min = 48.dp)
                    .semantics { contentDescription = "Reconnect interactive session without replaying commands" },
                onClick = onReconnectInteractive,
              ) { Text("Reconnect") }
            }
          }
          interactiveSnapshot?.receipts?.lastOrNull()?.let { receipt ->
            PiDroidStatusChip(
              "${receipt.kind.wireValue} ${receipt.lifecycle.name.lowercase()}",
              if (receipt.lifecycle.name == "SUCCEEDED") PiDroidStatusTone.POSITIVE else PiDroidStatusTone.WARNING,
            )
          }
          val selectedSession = ready.selected.session
          if (selectedSession == null) {
            PiDroidEmptyState(
              title = "No session selected",
              body =
                if (ready.selected.catalog.items
                    .isEmpty()
                ) {
                  "Create a session from the daemon's reviewed defaults."
                } else {
                  "Choose or adopt a session from the inventory."
                },
              modifier = Modifier.fillMaxWidth(),
            )
          } else {
            LiveSessionPresentation(
              session = selectedSession,
              interaction = interaction,
              interactiveSnapshot = interactiveSnapshot,
              active = active,
              destination = destination,
              onConnectInteractive = onConnectInteractive,
              onInteractiveAction = onInteractiveAction,
            )
          }
        }
        if (layout.showContextPane) {
          LiveContextPane(
            ready = ready,
            statusLabel = statusLabel,
            sessionAction = sessionAction,
            modifier = Modifier.width(236.dp).fillMaxHeight(),
          )
        }
      }
    }
  }
}

@Composable
private fun LiveTopBar(
  ready: LiveReadonlyState.Ready,
  statusLabel: String,
  statusTone: PiDroidStatusTone,
  backgroundMonitoring: Boolean,
  onRefresh: () -> Unit,
  onManageHosts: () -> Unit,
  onSelectHost: (HostId) -> Unit,
  onStartBackgroundMonitoring: () -> Unit,
  onStopBackgroundMonitoring: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text(
          "PI DROID",
          color = MaterialTheme.colorScheme.primary,
          fontWeight = FontWeight.Black,
        )
        Text(
          ready.selected.host.displayName,
          color = MaterialTheme.colorScheme.onBackground,
          style = MaterialTheme.typography.titleLarge,
          fontWeight = FontWeight.Bold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      PiDroidStatusChip(statusLabel, statusTone)
    }
    Row(
      modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      val freshness =
        ready.selected.session
          ?.host
          ?.freshness
      PiDroidStatusChip(
        when (freshness) {
          CacheFreshness.FRESH -> "Fresh"
          CacheFreshness.OFFLINE_CACHED -> "Offline cached"
          CacheFreshness.RECONNECTING -> "Reconnecting"
          CacheFreshness.RESYNCING -> "Resyncing"
          CacheFreshness.STALE -> "Stale"
          CacheFreshness.REMOVED -> "Removed"
          null -> "No session"
        },
        if (freshness == CacheFreshness.FRESH) PiDroidStatusTone.POSITIVE else PiDroidStatusTone.WARNING,
      )
      OutlinedButton(
        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Refresh hosts and session inventory" },
        onClick = onRefresh,
      ) { Text("Refresh") }
      OutlinedButton(
        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Manage registered hosts" },
        onClick = onManageHosts,
      ) { Text("Hosts") }
      OutlinedButton(
        modifier =
          Modifier
            .heightIn(min = 48.dp)
            .semantics {
              contentDescription =
                if (backgroundMonitoring) {
                  "Stop bounded background session monitoring"
                } else {
                  "Start bounded background session monitoring"
                }
            },
        onClick = if (backgroundMonitoring) onStopBackgroundMonitoring else onStartBackgroundMonitoring,
        enabled = backgroundMonitoring || ready.selected.session != null,
      ) { Text(if (backgroundMonitoring) "Stop monitor" else "Monitor") }
      ready.hosts.forEach { snapshot ->
        val selected = snapshot.host.id == ready.selectedHostId
        OutlinedButton(
          modifier =
            Modifier
              .heightIn(min = 48.dp)
              .semantics {
                contentDescription =
                  if (selected) {
                    "Host ${snapshot.host.displayName}, selected"
                  } else {
                    "Switch to host ${snapshot.host.displayName}"
                  }
              },
          onClick = { onSelectHost(snapshot.host.id) },
        ) {
          Text(
            snapshot.host.displayName,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
    }
  }
}

@Composable
private fun DailyDriverSessionCatalog(
  host: LiveHostSession,
  action: LiveSessionActionState,
  vertical: Boolean,
  onSelect: (String) -> Unit,
  onAdopt: (String) -> Unit,
  onCreate: (String?) -> Unit,
  onRefreshAction: () -> Unit,
  onClearAction: () -> Unit,
) {
  var showCreate by remember(host.host.id) { mutableStateOf(false) }
  var query by remember(host.host.id) { mutableStateOf("") }
  var filterName by rememberSaveable(host.host.id.value) { mutableStateOf(PiDroidSessionFilter.ALL.name) }
  val filter = PiDroidSessionFilter.valueOf(filterName)
  val mayStartAction =
    action == LiveSessionActionState.Idle ||
      action is LiveSessionActionState.Completed ||
      action is LiveSessionActionState.Failure
  val itemsById = host.catalog.items.associateBy(LiveSessionCatalogItem::inventoryId)
  val filteredItems =
    PiDroidSessionInventory
      .filter(
        sessions =
          host.catalog.items.map { item ->
            PiDroidSessionSummary(
              id = item.inventoryId,
              title = item.title,
              project = item.projectLabel,
              cwd = item.cwdBasename,
              state = item.state,
              unread = item.unread,
              activityAt = item.activityAt,
            )
          },
        query = query,
        filter = filter,
      ).mapNotNull { itemsById[it.id] }
  val base =
    if (vertical) {
      Modifier.fillMaxSize().padding(14.dp)
    } else {
      Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 4.dp)
    }
  Column(base, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      PiDroidSectionTitle(
        modifier = Modifier.weight(1f),
        eyebrow = "Sessions",
        title = if (vertical) "Inventory" else "Continue working",
        subtitle = "${host.catalog.items.size} available · ${host.catalog.retainedSessionCount} retained",
      )
      Button(
        onClick = { showCreate = true },
        enabled = host.catalog.createDefaults != null && mayStartAction,
        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Create a session from host defaults" },
      ) { Text("New") }
    }
    if (host.catalog.inventoryStale || host.catalog.inventoryReconciling) {
      PiDroidStatusChip(
        if (host.catalog.inventoryReconciling) "Inventory reconciling" else "Inventory stale",
        PiDroidStatusTone.WARNING,
      )
    }
    SessionActionBanner(action, onRefreshAction, onClearAction)
    OutlinedTextField(
      value = query,
      onValueChange = { query = it.take(128) },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Search session inventory" },
      label = { Text("Search sessions") },
      placeholder = { Text("Title, project, path, or state") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
      singleLine = true,
    )
    Row(
      modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      PiDroidSessionFilter.entries.forEach { candidate ->
        FilterChip(
          modifier =
            Modifier
              .heightIn(min = 48.dp)
              .semantics {
                contentDescription =
                  if (candidate == filter) {
                    "${candidate.label} sessions filter, selected"
                  } else {
                    "${candidate.label} sessions filter"
                  }
              },
          selected = candidate == filter,
          onClick = { filterName = candidate.name },
          label = { Text(candidate.label) },
        )
      }
    }
    if (filteredItems.isEmpty()) {
      PiDroidEmptyState(
        title = if (host.catalog.items.isEmpty()) "No sessions yet" else "No matching sessions",
        body =
          if (host.catalog.items.isEmpty()) {
            "Create a session from this host's reviewed defaults."
          } else {
            "Clear the search or choose another filter."
          },
        actionLabel = if (host.catalog.items.isEmpty()) null else "Clear filters",
        onAction =
          if (host.catalog.items.isEmpty()) {
            null
          } else {
            {
              query = ""
              filterName = PiDroidSessionFilter.ALL.name
            }
          },
      )
    } else if (vertical) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
        items(filteredItems, key = LiveSessionCatalogItem::inventoryId) { item ->
          SessionCatalogCard(
            item = item,
            selected = item.inventoryId == host.catalog.selectedInventoryId,
            vertical = true,
            mayStartAction = mayStartAction,
            onSelect = onSelect,
            onAdopt = onAdopt,
          )
        }
      }
    } else {
      Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        filteredItems.forEach { item ->
          SessionCatalogCard(
            item = item,
            selected = item.inventoryId == host.catalog.selectedInventoryId,
            vertical = false,
            mayStartAction = mayStartAction,
            onSelect = onSelect,
            onAdopt = onAdopt,
          )
        }
      }
    }
  }

  if (showCreate) {
    CreateSessionDialog(
      defaults = host.catalog.createDefaults,
      onDismiss = { showCreate = false },
      onCreate = { name ->
        onCreate(name)
        showCreate = false
      },
    )
  }
}

@Composable
private fun SessionCatalogCard(
  item: LiveSessionCatalogItem,
  selected: Boolean,
  vertical: Boolean,
  mayStartAction: Boolean,
  onSelect: (String) -> Unit,
  onAdopt: (String) -> Unit,
) {
  val relativeActivity = remember(item.activityAt) { PiDroidRelativeActivity.label(item.activityAt, Instant.now()) }
  val modifier =
    (if (vertical) Modifier.fillMaxWidth() else Modifier.width(276.dp))
      .border(
        1.dp,
        if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline.copy(alpha = 0.45f),
        MaterialTheme.shapes.medium,
      ).background(MaterialTheme.colorScheme.background.copy(alpha = 0.46f), MaterialTheme.shapes.medium)
      .padding(12.dp)
      .semantics {
        contentDescription =
          "Session ${item.title}, ${item.state}, $relativeActivity, ${if (item.managedSession != null) "managed" else "inventory only"}${if (selected) ", selected" else ""}${if (item.unread) ", unread" else ""}"
      }
  Column(modifier, verticalArrangement = Arrangement.spacedBy(7.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(
        item.title,
        modifier = Modifier.weight(1f),
        color = MaterialTheme.colorScheme.onSurface,
        fontWeight = FontWeight.Bold,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
      if (item.unread) PiDroidStatusChip("Unread", PiDroidStatusTone.INFO)
    }
    Text(
      listOfNotNull(item.projectLabel, item.cwdBasename, item.state, relativeActivity).joinToString(" · "),
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.labelSmall,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = { onSelect(item.inventoryId) }) {
        Text(if (selected) "Selected" else "Preview")
      }
      if (item.canAdopt) {
        Button(
          modifier =
            Modifier
              .heightIn(min = 48.dp)
              .semantics {
                contentDescription =
                  if (item.managedSession == null) {
                    "Adopt ${item.title}"
                  } else {
                    "Open exact retained ${item.title}"
                  }
              },
          onClick = { onAdopt(item.inventoryId) },
          enabled = mayStartAction,
        ) { Text(if (item.managedSession == null) "Adopt" else "Open") }
      }
    }
  }
}

@Composable
private fun CreateSessionDialog(
  defaults: LiveCreateSessionDefaults?,
  onDismiss: () -> Unit,
  onCreate: (String?) -> Unit,
) {
  var name by remember { mutableStateOf("") }
  val focus = LocalFocusManager.current
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Create from host defaults") },
    text = {
      Column(
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text(
          "Pi Droid sends the exact daemon-advertised root, model, tool, trust, and resource policy. Mobile cannot invent filesystem roots or inject a system prompt.",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
          value = name,
          onValueChange = { name = it.take(128) },
          modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Optional new session name" },
          label = { Text("Session name (optional)") },
          supportingText = { Text("${name.length}/128") },
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
          keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
          singleLine = true,
        )
        if (defaults == null) {
          PiDroidStatusChip("Creation unavailable", PiDroidStatusTone.WARNING)
        } else {
          CreatePolicyRow("Working directory", defaults.cwd)
          CreatePolicyRow("Persistence", defaults.persistence.wireValue)
          CreatePolicyRow(
            "Model",
            listOfNotNull(defaults.provider, defaults.modelId, defaults.thinkingLevel).joinToString(" · ").ifBlank { "Host default" },
          )
          CreatePolicyRow("Tools", defaults.toolMode)
          CreatePolicyRow("Project trust", defaults.projectTrust)
          CreatePolicyRow("System prompt", "Host-managed · no mobile override")
        }
      }
    },
    confirmButton = {
      Button(
        modifier =
          Modifier
            .heightIn(min = 48.dp)
            .semantics { contentDescription = "Create session once using displayed host policy" },
        onClick = {
          focus.clearFocus()
          onCreate(name.trim().takeIf(String::isNotEmpty))
          name = ""
        },
        enabled = defaults != null,
      ) { Text("Create once") }
    },
    dismissButton = {
      TextButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onDismiss) { Text("Cancel") }
    },
  )
}

@Composable
private fun CreatePolicyRow(
  label: String,
  value: String,
) {
  Column(Modifier.fillMaxWidth()) {
    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
    Text(value, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
  }
}

@Composable
private fun SessionActionBanner(
  action: LiveSessionActionState,
  onRefresh: () -> Unit,
  onClear: () -> Unit,
) {
  when (action) {
    LiveSessionActionState.Idle -> {}

    is LiveSessionActionState.Working -> {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(modifier = Modifier.width(18.dp).height(18.dp))
        Text(
          "${action.kind.name.lowercase().replaceFirstChar(Char::uppercase)} request in progress",
          color = MaterialTheme.colorScheme.primary,
        )
      }
    }

    is LiveSessionActionState.Accepted -> {
      ActionStateCard(
        title = "Request accepted · ${action.state.wireValue}",
        detail = "The original identity is retained. Refresh checks that ticket; it never sends again.",
        tone = PiDroidStatusTone.INFO,
        actionLabel = "Check receipt",
        onAction = onRefresh,
      )
    }

    is LiveSessionActionState.Indeterminate -> {
      ActionStateCard(
        title = "Outcome indeterminate · do not retry",
        detail =
          if (action.bookmark.ticketId == null) {
            "The response was lost before a ticket identity was known. Reconcile on the host before another request."
          } else {
            "The accepted ticket identity is retained and can be checked without replay."
          },
        tone = PiDroidStatusTone.WARNING,
        actionLabel = if (action.bookmark.ticketId == null) null else "Check existing ticket",
        onAction = onRefresh,
      )
    }

    is LiveSessionActionState.Failure -> {
      ActionStateCard(
        title = "Request failed · ${action.code.take(96)}",
        detail = if (action.retryable) "The host reported this failure as retryable." else "No side effect was accepted.",
        tone = PiDroidStatusTone.ERROR,
        actionLabel = "Dismiss",
        onAction = onClear,
      )
    }

    is LiveSessionActionState.Completed -> {
      ActionStateCard(
        title = "Session ready · generation ${action.session.generation}",
        detail = "The durable session identity is selected.",
        tone = PiDroidStatusTone.POSITIVE,
        actionLabel = "Dismiss",
        onAction = onClear,
      )
    }
  }
}

@Composable
private fun ActionStateCard(
  title: String,
  detail: String,
  tone: PiDroidStatusTone,
  actionLabel: String?,
  onAction: () -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
    shape = MaterialTheme.shapes.medium,
  ) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
      PiDroidStatusChip(title, tone)
      Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
      if (actionLabel != null) {
        OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onAction) { Text(actionLabel) }
      }
    }
  }
}

@Composable
private fun LiveSessionPresentation(
  session: com.harryaskham.pidroid.sessionui.SessionSurfaceState,
  interaction: LiveInteractiveAppState,
  interactiveSnapshot: LiveInteractiveSnapshot?,
  active: LiveInteractiveAppState.Ready?,
  destination: PiDroidDestination,
  onConnectInteractive: () -> Unit,
  onInteractiveAction: (RichInteractionAction) -> Unit,
) {
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val fontScale = LocalDensity.current.fontScale
    val layout = if (maxWidth < 720.dp) SessionSurfaceLayout.phone(fontScale) else SessionSurfaceLayout.tablet(fontScale)
    when (destination) {
      PiDroidDestination.TRANSCRIPT -> {
        if (interactiveSnapshot == null) {
          Box(Modifier.fillMaxSize()) {
            SessionSurface(
              state = session,
              layout = layout,
              chrome = SessionSurfaceChrome.READONLY,
              modifier = Modifier.fillMaxSize().padding(bottom = 92.dp),
            )
            Surface(
              modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(10.dp),
              color = MaterialTheme.colorScheme.surface,
              shape = MaterialTheme.shapes.large,
              border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
            ) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Column(Modifier.weight(1f)) {
                  Text("Observer not connected", color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.Bold)
                  Text("Observe first; request controller authority separately.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Button(
                  modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Connect interactive observer" },
                  onClick = onConnectInteractive,
                  enabled = interaction !is LiveInteractiveAppState.Connecting,
                ) { Text(if (interaction is LiveInteractiveAppState.Connecting) "Connecting" else "Connect") }
              }
            }
          }
        } else {
          RichInteractiveSessionSurface(
            session = session,
            interactive = interactiveSnapshot.rich,
            layout = layout,
            modifier = Modifier.fillMaxSize(),
            onAction = onInteractiveAction,
          )
        }
      }

      PiDroidDestination.TREE -> {
        val tree = interactiveSnapshot?.tree
        if (tree == null) {
          InteractiveStatus("Branch tree unavailable", "Connect as an observer to load the exact active tree.")
        } else {
          SessionTreeSurface(
            snapshot = tree,
            context =
              InteractionContext(
                identity = tree.identity,
                role =
                  if (interactiveSnapshot.role == InteractiveControllerRole.CONTROLLER) {
                    SessionRole.CONTROLLER
                  } else {
                    SessionRole.OBSERVER
                  },
                freshness = session.host.freshness,
              ),
            modifier = Modifier.fillMaxSize(),
          )
        }
      }

      PiDroidDestination.TERMINAL -> {
        val tui = active?.tui
        if (tui == null) {
          InteractiveStatus("Terminal unavailable", "Waiting for a validated canonical server-side TUI snapshot.")
        } else {
          TuiSurface(
            state = tui,
            layout = if (maxWidth < 720.dp) TuiSurfaceLayout.phone(fontScale) else TuiSurfaceLayout.tablet(fontScale),
            modifier = Modifier.fillMaxSize(),
          )
        }
      }

      PiDroidDestination.EXTENSIONS -> {
        PiDroidEmptyState(
          title = "No validated extension view",
          body =
            "This host has not delivered a declarative extension surface. " +
              "Pi Droid never executes arbitrary extension code or imports project UI.",
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }
  }
}

@Composable
private fun LiveContextPane(
  ready: LiveReadonlyState.Ready,
  statusLabel: String,
  sessionAction: LiveSessionActionState,
  modifier: Modifier,
) {
  val freshness =
    ready.selected.session
      ?.host
      ?.freshness
  val actionLabel =
    when (sessionAction) {
      LiveSessionActionState.Idle -> "idle"
      is LiveSessionActionState.Working -> "working"
      is LiveSessionActionState.Accepted -> "accepted"
      is LiveSessionActionState.Completed -> "completed"
      is LiveSessionActionState.Indeterminate -> "indeterminate"
      is LiveSessionActionState.Failure -> "failed"
    }
  Surface(
    modifier = modifier,
    color = MaterialTheme.colorScheme.surface,
    shape = MaterialTheme.shapes.large,
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
  ) {
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      PiDroidSectionTitle(
        eyebrow = "Context",
        title = "Live safety",
        subtitle = "Explicit authority and freshness",
      )
      ContextRow("Connection", freshness?.name?.lowercase()?.replace('_', ' ') ?: "No session")
      ContextRow("Role", statusLabel.lowercase())
      ContextRow("Action", actionLabel)
      PiDroidStatusChip(
        when (freshness) {
          CacheFreshness.FRESH -> "Fresh"
          CacheFreshness.OFFLINE_CACHED -> "Offline cached"
          CacheFreshness.RECONNECTING -> "Reconnecting"
          CacheFreshness.RESYNCING -> "Resyncing"
          CacheFreshness.STALE -> "Stale"
          CacheFreshness.REMOVED -> "Removed"
          null -> "No session"
        },
        if (freshness == CacheFreshness.FRESH) PiDroidStatusTone.POSITIVE else PiDroidStatusTone.WARNING,
      )
      Text(
        "Reconnect is explicit. Accepted and indeterminate actions are never replayed blindly.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
      )
      Spacer(Modifier.weight(1f))
      PiDroidStatusChip("No secrets retained", PiDroidStatusTone.MUTED)
    }
  }
}

@Composable
private fun ContextRow(
  label: String,
  value: String,
) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(label, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(value, color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)
  }
}

@Composable
private fun InteractiveStatus(
  title: String,
  detail: String,
) {
  Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
    PiDroidEmptyState(title = title, body = detail)
  }
}

@Composable
private fun StatusScreen(
  title: String,
  detail: String,
  onRefresh: () -> Unit,
  onManageHosts: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxSize().padding(20.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    PiDroidErrorState(
      title = title,
      body = detail,
      retryLabel = "Retry",
      onRetry = onRefresh,
    )
    OutlinedButton(
      modifier = Modifier.padding(top = 10.dp).heightIn(min = 48.dp),
      onClick = onManageHosts,
    ) { Text("Manage hosts") }
  }
}
