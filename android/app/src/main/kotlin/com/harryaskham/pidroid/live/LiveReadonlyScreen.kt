package com.harryaskham.pidroid.live

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.SessionRole
import com.harryaskham.pidroid.sessionui.InteractionContext
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import com.harryaskham.pidroid.sessionui.RichInteractiveSessionSurface
import com.harryaskham.pidroid.sessionui.RichInteractiveState
import com.harryaskham.pidroid.sessionui.SessionSurface
import com.harryaskham.pidroid.sessionui.SessionSurfaceChrome
import com.harryaskham.pidroid.sessionui.SessionSurfaceLayout
import com.harryaskham.pidroid.sessionui.SessionTreeSurface
import com.harryaskham.pidroid.sessionui.TuiSurface
import com.harryaskham.pidroid.sessionui.TuiSurfaceLayout

private val LiveCanvas = Color(0xFF0C111B)
private val LiveSurface = Color(0xFF121A28)
private val LivePrimary = Color(0xFFE8EEF7)
private val LiveMuted = Color(0xFF91A0B7)
private val LiveAccent = Color(0xFF82D2E5)
private val LiveGreen = Color(0xFFA8D8A0)
private val LiveWarning = Color(0xFFE7C987)

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
  var showHostManagement by remember { mutableStateOf(state == LiveReadonlyState.Unconfigured) }
  LaunchedEffect(hostManagement.notice) {
    if (hostManagement.notice is HostManagementNotice.DuplicateEndpoint) showHostManagement = true
  }
  MaterialTheme {
    Surface(modifier = Modifier.fillMaxSize(), color = LiveCanvas) {
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
          StatusScreen("Choose a host", "No active host is configured", LiveWarning, onRefresh) {
            showHostManagement = true
          }
        }

        is LiveReadonlyState.Loading -> {
          StatusScreen("Connecting", state.message, LiveAccent, onRefresh) { showHostManagement = true }
        }

        is LiveReadonlyState.Failure -> {
          StatusScreen("Host unavailable", state.code, LiveWarning, onRefresh) { showHostManagement = true }
        }

        is LiveReadonlyState.Ready -> {
          LiveSessionScreen(
            state,
            interaction,
            onRefresh,
            { showHostManagement = true },
            onSelectHost,
            onSelectSession,
            onCreateSession,
            onAdoptSession,
            sessionAction,
            onRefreshSessionAction,
            onClearSessionAction,
            backgroundMonitoring,
            onStartBackgroundMonitoring,
            onStopBackgroundMonitoring,
            onConnectInteractive,
            onInteractiveAction,
            onReconnectInteractive,
          )
        }
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
    Text("PI DROID", color = LiveAccent, fontWeight = FontWeight.Black)
    Text("EXTERNAL CANARY · READONLY", color = LivePrimary, style = MaterialTheme.typography.headlineMedium)
    Text(
      "Content-free physical proof. No create, update, delete, prompt, control, or restart action is available.",
      color = LiveMuted,
    )
    when (state) {
      LiveReadonlyState.Unconfigured -> {
        Text("PAIRING · PENDING", color = LiveWarning, fontWeight = FontWeight.Bold)
      }

      is LiveReadonlyState.Loading -> {
        Text("READINESS · CHECKING", color = LiveWarning, fontWeight = FontWeight.Bold)
      }

      is LiveReadonlyState.Failure -> {
        Text("CANARY · FAILED · ${state.code.uppercase()}", color = LiveWarning, fontWeight = FontWeight.Bold)
      }

      is LiveReadonlyState.Ready -> {
        val selected = state.selected
        val fresh = selected.session?.host?.freshness == CacheFreshness.FRESH
        Text("HOST LISTING · VERIFIED", color = LiveGreen, fontWeight = FontWeight.Bold)
        Text(
          if (fresh) "READINESS · READY" else "READINESS · NOT FRESH",
          color = if (fresh) LiveGreen else LiveWarning,
          fontWeight = FontWeight.Bold,
        )
        Text(
          if (fresh) "READONLY HYDRATION · VERIFIED" else "READONLY HYDRATION · NOT VERIFIED",
          color = if (fresh) LiveGreen else LiveWarning,
          fontWeight = FontWeight.Bold,
        )
        Text(
          when {
            selected.rpcObserverConnected -> "OBSERVER · ATTACHED TO IDLE SESSION"
            selected.rpcObserverEligible -> "OBSERVER · ATTACH FAILED"
            else -> "OBSERVER · NOT REQUESTED"
          },
          color = if (selected.rpcObserverEligible && !selected.rpcObserverConnected) LiveWarning else LiveGreen,
          fontWeight = FontWeight.Bold,
        )
        Text("MUTATION SURFACE · ABSENT", color = LiveGreen, fontWeight = FontWeight.Bold)
      }
    }
  }
}

@Composable
public fun HostRegistrationScreen(
  onRegisterManual: (String, String, CharArray, String?, Boolean) -> Unit,
  onRegisterEnvelope: (String, Boolean) -> Unit,
) {
  var endpoint by remember { mutableStateOf("https://") }
  var displayName by remember { mutableStateOf("") }
  var bearer by remember { mutableStateOf("") }
  var fingerprint by remember { mutableStateOf("") }
  var envelope by remember { mutableStateOf("") }
  var confirmInsecure by remember { mutableStateOf(false) }

  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Text("PI DROID", color = LiveAccent, fontWeight = FontWeight.Black)
    Text("Connect a trusted-tailnet Pi Daemon", color = LivePrimary, style = MaterialTheme.typography.headlineMedium)
    Text(
      "Add a trusted host without exposing its bearer. You can edit, re-pair, or forget it later from Hosts.",
      color = LiveMuted,
    )
    OutlinedTextField(
      value = endpoint,
      onValueChange = { endpoint = it.take(2_048) },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Pi Daemon API URL" },
      label = { Text("API URL") },
      singleLine = true,
    )
    OutlinedTextField(
      value = displayName,
      onValueChange = { displayName = it.take(128) },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Host name") },
      singleLine = true,
    )
    OutlinedTextField(
      value = bearer,
      onValueChange = { bearer = it.take(4_096) },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Service bearer" },
      label = { Text("Service bearer") },
      visualTransformation = PasswordVisualTransformation(),
      singleLine = true,
    )
    OutlinedTextField(
      value = fingerprint,
      onValueChange = { fingerprint = it.take(95).uppercase() },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Optional certificate SHA-256") },
      singleLine = true,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
      Checkbox(checked = confirmInsecure, onCheckedChange = { confirmInsecure = it })
      Spacer(Modifier.width(8.dp))
      Text("Allow this explicitly entered remote HTTP endpoint", color = LiveMuted)
    }
    Button(
      onClick = {
        val temporary = bearer.toCharArray()
        bearer = ""
        onRegisterManual(endpoint, displayName, temporary, fingerprint.ifBlank { null }, confirmInsecure)
      },
      enabled = endpoint.isNotBlank() && displayName.isNotBlank() && bearer.isNotBlank(),
    ) {
      Text("Register host")
    }
    Spacer(Modifier.height(8.dp))
    Text("ASCII / QR pairing envelope", color = LivePrimary, fontWeight = FontWeight.Bold)
    OutlinedTextField(
      value = envelope,
      onValueChange = { envelope = it.take(16_384) },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("pidroid://pair/v1/…") },
      minLines = 3,
    )
    OutlinedButton(
      onClick = {
        val submitted = envelope
        envelope = ""
        onRegisterEnvelope(submitted, confirmInsecure)
      },
      enabled = envelope.startsWith("pidroid://pair/v1/"),
    ) {
      Text("Import pairing envelope")
    }
  }
}

private enum class LivePresentation {
  RICH,
  TREE,
  TUI,
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
  var presentation by remember(ready.selectedHostId) { mutableStateOf(LivePresentation.RICH) }
  val active =
    (interaction as? LiveInteractiveAppState.Ready)
      ?.takeIf { it.hostId == ready.selectedHostId }
  val interactiveSnapshot =
    when (interaction) {
      is LiveInteractiveAppState.Ready -> interaction.snapshot.takeIf { interaction.hostId == ready.selectedHostId }
      is LiveInteractiveAppState.Failure -> interaction.lastSnapshot?.takeIf { interaction.hostId == ready.selectedHostId }
      else -> null
    }
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val wide = maxWidth >= 840.dp
    Row(Modifier.fillMaxSize()) {
      if (wide) {
        Surface(modifier = Modifier.width(320.dp).fillMaxSize(), color = LiveSurface) {
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
      Column(Modifier.weight(1f).fillMaxSize()) {
        Row(
          modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          OutlinedButton(
            onClick = onRefresh,
            modifier = Modifier.semantics { contentDescription = "Refresh hosts and session inventory" },
          ) {
            Text("Refresh")
          }
          OutlinedButton(
            onClick = onManageHosts,
            modifier = Modifier.semantics { contentDescription = "Manage registered hosts" },
          ) {
            Text("Hosts")
          }
          OutlinedButton(
            onClick = if (backgroundMonitoring) onStopBackgroundMonitoring else onStartBackgroundMonitoring,
            enabled = backgroundMonitoring || ready.selected.session != null,
            modifier =
              Modifier.semantics {
                contentDescription =
                  if (backgroundMonitoring) {
                    "Stop bounded background session monitoring"
                  } else {
                    "Start bounded background session monitoring"
                  }
              },
          ) {
            Text(if (backgroundMonitoring) "Stop monitor" else "Monitor")
          }
          ready.hosts.forEach { snapshot ->
            val selected = snapshot.host.id == ready.selectedHostId
            OutlinedButton(onClick = { onSelectHost(snapshot.host.id) }) {
              Text(snapshot.host.displayName, color = if (selected) LiveAccent else LiveMuted)
            }
          }
          Text(
            liveInteractiveStatusLabel(interaction, ready.selectedHostId, ready.selected.rpcObserverConnected),
            color = if (interactiveSnapshot?.role == InteractiveControllerRole.CONTROLLER) LiveGreen else LiveWarning,
            fontWeight = FontWeight.Bold,
          )
        }
        if (!wide) {
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
          modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          LivePresentation.entries.forEach { item ->
            OutlinedButton(
              onClick = { presentation = item },
              modifier = Modifier.semantics { contentDescription = "Show ${item.name.lowercase()} presentation" },
            ) {
              Text(item.name, color = if (presentation == item) LiveAccent else LiveMuted)
            }
          }
          interactiveSnapshot?.receipts?.lastOrNull()?.let { receipt ->
            Text(
              "${receipt.kind.wireValue.uppercase()} ${receipt.lifecycle.name}",
              modifier =
                Modifier.semantics {
                  contentDescription = "Command ${receipt.kind.wireValue} ${receipt.lifecycle.name.lowercase()}"
                },
              color = if (receipt.lifecycle.name == "SUCCEEDED") LiveGreen else LiveWarning,
              fontWeight = FontWeight.Bold,
            )
          }
          if (interaction is LiveInteractiveAppState.Failure) {
            OutlinedButton(
              onClick = onReconnectInteractive,
              modifier = Modifier.semantics { contentDescription = "Reconnect interactive session without replaying commands" },
            ) {
              Text("Reconnect")
            }
          }
        }
        val selectedSession = ready.selected.session
        if (selectedSession == null) {
          InteractiveStatus(
            "No session selected",
            if (ready.selected.catalog.items
                .isEmpty()
            ) {
              "Create a session from the daemon's reviewed defaults."
            } else {
              "Choose or adopt an inventory session."
            },
          )
        } else {
          LiveSessionPresentation(
            session = selectedSession,
            interaction = interaction,
            interactiveSnapshot = interactiveSnapshot,
            active = active,
            presentation = presentation,
            onConnectInteractive = onConnectInteractive,
            onInteractiveAction = onInteractiveAction,
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
  var name by remember(host.host.id) { mutableStateOf("") }
  val mayStartAction =
    action == LiveSessionActionState.Idle ||
      action is LiveSessionActionState.Completed ||
      action is LiveSessionActionState.Failure
  val base =
    if (vertical) {
      Modifier.fillMaxSize().padding(14.dp)
    } else {
      Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
    }
  Column(base, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Column(Modifier.weight(1f)) {
        Text("Sessions", color = LivePrimary, fontWeight = FontWeight.Bold)
        Text(
          "${host.catalog.items.size} inventory · ${host.catalog.retainedSessionCount} retained",
          color = LiveMuted,
          style = MaterialTheme.typography.labelSmall,
        )
      }
      Button(
        onClick = { showCreate = !showCreate },
        enabled = host.catalog.createDefaults != null && mayStartAction,
        modifier = Modifier.semantics { contentDescription = "Create a session from host defaults" },
      ) {
        Text(if (showCreate) "Close" else "New")
      }
    }
    if (host.catalog.inventoryStale || host.catalog.inventoryReconciling) {
      Text(
        if (host.catalog.inventoryReconciling) "Inventory reconciling" else "Inventory is stale",
        color = LiveWarning,
        fontWeight = FontWeight.Bold,
      )
    }
    SessionActionBanner(action, onRefreshAction, onClearAction)
    if (showCreate) {
      CreateSessionForm(
        defaults = host.catalog.createDefaults,
        name = name,
        onNameChange = { name = it.take(128) },
        onCreate = {
          onCreate(name.trim().takeIf(String::isNotEmpty))
          name = ""
          showCreate = false
        },
      )
    }
    if (host.catalog.items.isEmpty()) {
      Text("No sessions on this host yet.", color = LiveMuted)
    } else if (vertical) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
        items(host.catalog.items, key = LiveSessionCatalogItem::inventoryId) { item ->
          SessionCatalogCard(item, item.inventoryId == host.catalog.selectedInventoryId, true, mayStartAction, onSelect, onAdopt)
        }
      }
    } else {
      Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        host.catalog.items.forEach { item ->
          SessionCatalogCard(item, item.inventoryId == host.catalog.selectedInventoryId, false, mayStartAction, onSelect, onAdopt)
        }
      }
    }
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
  val modifier =
    (if (vertical) Modifier.fillMaxWidth() else Modifier.width(260.dp))
      .border(1.dp, if (selected) LiveAccent else LiveMuted.copy(alpha = 0.35f), MaterialTheme.shapes.medium)
      .background(LiveCanvas, MaterialTheme.shapes.medium)
      .padding(10.dp)
      .semantics {
        contentDescription =
          "Session ${item.title}, ${item.state}, ${if (item.managedSession != null) "managed" else "inventory only"}${if (item.unread) ", unread" else ""}"
      }
  Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(item.title, color = LivePrimary, fontWeight = FontWeight.Bold, maxLines = 2)
    Text(
      listOfNotNull(item.projectLabel, item.cwdBasename, item.state).joinToString(" · "),
      color = LiveMuted,
      style = MaterialTheme.typography.labelSmall,
      maxLines = 2,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(onClick = { onSelect(item.inventoryId) }) { Text(if (selected) "Selected" else "Preview") }
      if (item.canAdopt) {
        Button(
          onClick = { onAdopt(item.inventoryId) },
          enabled = mayStartAction,
          modifier =
            Modifier.semantics {
              contentDescription = if (item.managedSession == null) "Adopt ${item.title}" else "Open exact retained ${item.title}"
            },
        ) {
          Text(if (item.managedSession == null) "Adopt" else "Open")
        }
      }
    }
  }
}

@Composable
private fun CreateSessionForm(
  defaults: LiveCreateSessionDefaults?,
  name: String,
  onNameChange: (String) -> Unit,
  onCreate: () -> Unit,
) {
  Surface(color = LiveCanvas, shape = MaterialTheme.shapes.medium) {
    Column(
      Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text("Create from reviewed host profile", color = LivePrimary, fontWeight = FontWeight.Bold)
      Text(
        "Pi Droid sends the exact daemon-advertised root, model, tool and resource policy. Mobile cannot invent filesystem roots or inject a system prompt.",
        color = LiveMuted,
        style = MaterialTheme.typography.bodySmall,
      )
      OutlinedTextField(
        value = name,
        onValueChange = onNameChange,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Optional new session name" },
        label = { Text("Session name (optional)") },
        singleLine = true,
      )
      if (defaults == null) {
        Text("Configured session creation is unavailable on this host.", color = LiveWarning)
      } else {
        CreatePolicyRow("Working directory", defaults.cwd)
        CreatePolicyRow("Persistence", defaults.persistence.wireValue)
        CreatePolicyRow(
          "Model",
          listOfNotNull(defaults.provider, defaults.modelId, defaults.thinkingLevel).joinToString(" · ").ifBlank {
            "Host default"
          },
        )
        CreatePolicyRow("Tools", defaults.toolMode)
        CreatePolicyRow("Project trust", defaults.projectTrust)
        CreatePolicyRow("System prompt", "Host-managed · no mobile override")
        Button(
          onClick = onCreate,
          modifier = Modifier.semantics { contentDescription = "Create session once using displayed host policy" },
        ) {
          Text("Create once")
        }
      }
    }
  }
}

@Composable
private fun CreatePolicyRow(
  label: String,
  value: String,
) {
  Column(Modifier.fillMaxWidth()) {
    Text(label, color = LiveMuted, style = MaterialTheme.typography.labelSmall)
    Text(value, color = LivePrimary, style = MaterialTheme.typography.bodyMedium)
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
        Text("${action.kind.name.lowercase().replaceFirstChar(Char::uppercase)} request in progress", color = LiveAccent)
      }
    }

    is LiveSessionActionState.Accepted -> {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Request accepted · ${action.state.wireValue}", color = LiveAccent, fontWeight = FontWeight.Bold)
        Text("The original identity is retained. Refresh checks that ticket; it never sends again.", color = LiveMuted)
        OutlinedButton(onClick = onRefresh) { Text("Check receipt") }
      }
    }

    is LiveSessionActionState.Indeterminate -> {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Outcome indeterminate · do not retry", color = LiveWarning, fontWeight = FontWeight.Bold)
        Text(
          if (action.bookmark.ticketId == null) {
            "The response was lost before a ticket identity was known. Reconcile on the host before another request."
          } else {
            "The accepted ticket identity is retained and can be checked without replay."
          },
          color = LiveMuted,
        )
        if (action.bookmark.ticketId != null) OutlinedButton(onClick = onRefresh) { Text("Check existing ticket") }
      }
    }

    is LiveSessionActionState.Failure -> {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Request failed · ${action.code}", color = LiveWarning, fontWeight = FontWeight.Bold)
        Text(if (action.retryable) "The host reported this failure as retryable." else "No side effect was accepted.", color = LiveMuted)
        OutlinedButton(onClick = onClear) { Text("Dismiss") }
      }
    }

    is LiveSessionActionState.Completed -> {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Session ready · generation ${action.session.generation}", color = LiveGreen, fontWeight = FontWeight.Bold)
        OutlinedButton(onClick = onClear) { Text("Dismiss") }
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
  presentation: LivePresentation,
  onConnectInteractive: () -> Unit,
  onInteractiveAction: (RichInteractionAction) -> Unit,
) {
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val fontScale = LocalDensity.current.fontScale
    val layout = if (maxWidth < 720.dp) SessionSurfaceLayout.phone(fontScale) else SessionSurfaceLayout.tablet(fontScale)
    when (presentation) {
      LivePresentation.RICH -> {
        if (interactiveSnapshot == null) {
          Box(Modifier.fillMaxSize()) {
            SessionSurface(
              state = session,
              layout = layout,
              chrome = SessionSurfaceChrome.READONLY,
              modifier = Modifier.fillMaxSize().padding(bottom = 88.dp),
            )
            Surface(
              modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(10.dp),
              color = LiveSurface,
            ) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Column(Modifier.weight(1f)) {
                  Text("Observer not connected", color = LivePrimary, fontWeight = FontWeight.Bold)
                  Text("Observe first; request controller authority separately.", color = LiveMuted)
                }
                Button(
                  onClick = onConnectInteractive,
                  enabled = interaction !is LiveInteractiveAppState.Connecting,
                  modifier = Modifier.semantics { contentDescription = "Connect interactive observer" },
                ) {
                  Text(if (interaction is LiveInteractiveAppState.Connecting) "Connecting" else "Connect")
                }
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

      LivePresentation.TREE -> {
        val tree = interactiveSnapshot?.tree
        if (tree == null) {
          InteractiveStatus("Branch tree unavailable", "Request control to load the exact active tree")
        } else {
          SessionTreeSurface(
            snapshot = tree,
            context =
              InteractionContext(
                identity = tree.identity,
                role =
                  if (interactiveSnapshot.role ==
                    InteractiveControllerRole.CONTROLLER
                  ) {
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

      LivePresentation.TUI -> {
        val tui = active?.tui
        if (tui == null) {
          InteractiveStatus("TUI unavailable", "Waiting for a canonical server-side TUI snapshot")
        } else {
          TuiSurface(
            state = tui,
            layout = if (maxWidth < 720.dp) TuiSurfaceLayout.phone(fontScale) else TuiSurfaceLayout.tablet(fontScale),
            modifier = Modifier.fillMaxSize(),
          )
        }
      }
    }
  }
}

@Composable
private fun InteractiveStatus(
  title: String,
  detail: String,
) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(title, color = LivePrimary, style = MaterialTheme.typography.headlineSmall)
      Text(detail, color = LiveMuted)
    }
  }
}

@Composable
private fun StatusScreen(
  title: String,
  detail: String,
  accent: Color,
  onRefresh: () -> Unit,
  onManageHosts: () -> Unit,
) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(title, color = LivePrimary, style = MaterialTheme.typography.headlineMedium)
      Text(detail, color = accent)
      Text("Live readonly session", color = LiveMuted, fontWeight = FontWeight.Bold)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onRefresh) { Text("Retry") }
        OutlinedButton(onClick = onManageHosts) { Text("Hosts") }
      }
    }
  }
}
