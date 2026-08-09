package com.harryaskham.pidroid.live

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.TransportSecurity
import com.harryaskham.pidroid.workspace.PiDroidEndpointPolicy
import com.harryaskham.pidroid.workspace.PiDroidEndpointSecurityCard
import com.harryaskham.pidroid.workspace.PiDroidSectionTitle
import com.harryaskham.pidroid.workspace.PiDroidStatusChip
import com.harryaskham.pidroid.workspace.PiDroidStatusTone

private enum class HostManagementMode {
  LIST,
  ADD,
  EDIT,
  REPAIR,
}

internal fun hostSecurityLabel(host: RegisteredHost): String =
  when {
    host.tlsFingerprint != null -> "HTTPS · pinned certificate"
    host.transportSecurity == TransportSecurity.HTTPS -> "HTTPS · platform trust"
    host.transportSecurity == TransportSecurity.LOOPBACK_PLAINTEXT -> "HTTP · loopback only"
    else -> "HTTP · explicitly trusted tailnet"
  }

internal fun hostReadinessLabel(
  hostId: HostId,
  liveState: LiveReadonlyState,
): String {
  if (liveState is LiveReadonlyState.Loading) return "CHECKING"
  val session = (liveState as? LiveReadonlyState.Ready)?.hosts?.firstOrNull { it.host.id == hostId }
  return when (session?.session?.host?.freshness) {
    CacheFreshness.FRESH -> "READY"
    CacheFreshness.RECONNECTING -> "RECONNECTING"
    CacheFreshness.RESYNCING -> "RESYNCING"
    CacheFreshness.OFFLINE_CACHED -> "OFFLINE · CACHED"
    CacheFreshness.STALE -> "STALE"
    CacheFreshness.REMOVED -> "MISSING"
    null -> "UNAVAILABLE"
  }
}

@Composable
public fun HostManagementScreen(
  state: HostManagementState,
  liveState: LiveReadonlyState,
  onClose: () -> Unit,
  onRegisterManual: (String, String, CharArray, String?, Boolean) -> Unit,
  onRegisterEnvelope: (String, Boolean) -> Unit,
  onUpdateHost: (HostId, String, String, String?, Boolean) -> Unit,
  onReplaceHost: (HostId, String, String, CharArray, String?, Boolean) -> Unit,
  onReplaceHostEnvelope: (HostId, String, Boolean) -> Unit,
  onForgetHost: (HostId) -> Unit,
  onSelectDefault: (HostId) -> Unit,
  onClearNotice: () -> Unit,
) {
  var mode by remember { mutableStateOf(if (state.hosts.isEmpty()) HostManagementMode.ADD else HostManagementMode.LIST) }
  var selectedHostValue by remember { mutableStateOf<String?>(null) }
  var pendingForget by remember { mutableStateOf<HostId?>(null) }
  val selectedHostId = selectedHostValue?.let(::HostId)

  fun returnToList() {
    selectedHostValue = null
    mode = HostManagementMode.LIST
  }

  BackHandler(enabled = pendingForget != null || mode != HostManagementMode.LIST || state.hosts.isNotEmpty()) {
    when {
      pendingForget != null -> pendingForget = null
      mode != HostManagementMode.LIST && state.hosts.isNotEmpty() -> returnToList()
      state.hosts.isNotEmpty() -> onClose()
    }
  }

  LaunchedEffect(state.hosts, state.notice) {
    val duplicate = state.notice as? HostManagementNotice.DuplicateEndpoint
    when {
      duplicate != null && state.hosts.any { it.id == duplicate.hostId } -> {
        selectedHostValue = duplicate.hostId.value
        mode = HostManagementMode.REPAIR
      }

      state.notice is HostManagementNotice.Added -> {
        returnToList()
      }

      state.hosts.isEmpty() -> {
        selectedHostValue = null
        mode = HostManagementMode.ADD
      }

      selectedHostId != null && state.hosts.none { it.id == selectedHostId } -> {
        returnToList()
      }
    }
  }

  Surface(
    modifier = Modifier.fillMaxSize(),
    color = MaterialTheme.colorScheme.background,
  ) {
    Column(Modifier.fillMaxSize()) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        PiDroidSectionTitle(
          modifier = Modifier.weight(1f),
          eyebrow = "Pi Droid",
          title = if (state.hosts.isEmpty()) "Welcome" else "Hosts",
          subtitle =
            if (state.hosts.isEmpty()) {
              "Connect your first trusted Pi Daemon"
            } else {
              "${state.hosts.size} isolated ${if (state.hosts.size == 1) "host" else "hosts"}"
            },
        )
        if (state.hosts.isNotEmpty()) {
          TextButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onClose) { Text("Done") }
        }
      }

      HostManagementNoticeCard(state, onClearNotice)

      when (mode) {
        HostManagementMode.ADD -> {
          if (state.hosts.isNotEmpty()) {
            TextButton(
              onClick = ::returnToList,
              modifier = Modifier.padding(horizontal = 16.dp).heightIn(min = 48.dp),
            ) { Text("Back to hosts") }
          }
          HostRegistrationScreen(onRegisterManual, onRegisterEnvelope)
        }

        HostManagementMode.EDIT,
        HostManagementMode.REPAIR,
        -> {
          val selected = state.hosts.firstOrNull { it.id == selectedHostId }
          if (selected == null) {
            MissingHostState(
              onBack = ::returnToList,
              onAdd = { mode = HostManagementMode.ADD },
            )
          } else {
            HostEditor(
              host = selected,
              replaceCredential = mode == HostManagementMode.REPAIR,
              onBack = ::returnToList,
              onUpdateHost = onUpdateHost,
              onReplaceHost = onReplaceHost,
              onReplaceHostEnvelope = onReplaceHostEnvelope,
            )
          }
        }

        HostManagementMode.LIST -> {
          Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
          ) {
            Text(
              "Each host keeps its own encrypted bearer, connection, cache, and session selection.",
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            state.hosts.forEach { host ->
              HostCard(
                host = host,
                readiness = hostReadinessLabel(host.id, liveState),
                isDefault = state.defaultHostId == host.id,
                onSelectDefault = { onSelectDefault(host.id) },
                onEdit = {
                  selectedHostValue = host.id.value
                  mode = HostManagementMode.EDIT
                },
                onRepair = {
                  selectedHostValue = host.id.value
                  mode = HostManagementMode.REPAIR
                },
                onForget = { pendingForget = host.id },
              )
            }
            Button(
              onClick = { mode = HostManagementMode.ADD },
              modifier =
                Modifier
                  .heightIn(min = 48.dp)
                  .semantics { contentDescription = "Add another Pi Daemon host" },
            ) { Text("Add another host") }
          }
        }
      }
    }
  }

  val forgotten = state.hosts.firstOrNull { it.id == pendingForget }
  if (forgotten != null) {
    AlertDialog(
      onDismissRequest = { pendingForget = null },
      title = { Text("Forget ${forgotten.displayName}?") },
      text = {
        Text(
          "This removes only this host's metadata, encrypted credential, cached connection, and local session views. Other hosts stay registered.",
        )
      },
      confirmButton = {
        TextButton(
          modifier = Modifier.heightIn(min = 48.dp),
          onClick = {
            pendingForget = null
            onForgetHost(forgotten.id)
          },
        ) { Text("Forget", color = MaterialTheme.colorScheme.error) }
      },
      dismissButton = {
        TextButton(modifier = Modifier.heightIn(min = 48.dp), onClick = { pendingForget = null }) { Text("Cancel") }
      },
    )
  }
}

@Composable
public fun HostRegistrationScreen(
  onRegisterManual: (String, String, CharArray, String?, Boolean) -> Unit,
  onRegisterEnvelope: (String, Boolean) -> Unit,
) {
  var endpoint by remember { mutableStateOf("https://") }
  var displayName by remember { mutableStateOf("") }
  var fingerprint by remember { mutableStateOf("") }
  var bearer by remember { mutableStateOf("") }
  var envelope by remember { mutableStateOf("") }
  var confirmInsecure by remember { mutableStateOf(false) }
  var confirmEnvelopeInsecure by remember { mutableStateOf(false) }
  val focus = LocalFocusManager.current
  val assessment = PiDroidEndpointPolicy.assess(endpoint)
  val endpointReady = assessment.canConnect && (!assessment.requiresCleartextAcknowledgement || confirmInsecure)

  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    PiDroidSectionTitle(
      eyebrow = if (displayName.isBlank()) "Step 1 of 1" else "Ready to connect",
      title = "Add a trusted host",
      subtitle = "Use HTTPS when possible. Secret fields are cleared after submission and never restored after process death.",
    )
    OutlinedTextField(
      value = endpoint,
      onValueChange = {
        endpoint = it.take(2_048)
        confirmInsecure = false
      },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Pi Daemon API URL" },
      label = { Text("API URL") },
      supportingText = { Text("Example: https://pi.example.test:9443") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
      keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
      singleLine = true,
    )
    PiDroidEndpointSecurityCard(
      assessment = assessment,
      acknowledged = confirmInsecure,
      onAcknowledgedChange = { confirmInsecure = it },
    )
    OutlinedTextField(
      value = displayName,
      onValueChange = { displayName = it.take(128) },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Host name") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
      keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
      singleLine = true,
    )
    OutlinedTextField(
      value = bearer,
      onValueChange = { bearer = it.take(4_096) },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Service bearer" },
      label = { Text("Service bearer") },
      visualTransformation = PasswordVisualTransformation(),
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
      keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
      singleLine = true,
    )
    OutlinedTextField(
      value = fingerprint,
      onValueChange = { fingerprint = it.take(95).uppercase() },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Optional certificate SHA-256") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
      keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
      singleLine = true,
    )
    Button(
      modifier = Modifier.heightIn(min = 48.dp),
      onClick = {
        focus.clearFocus()
        val temporary = bearer.toCharArray()
        bearer = ""
        onRegisterManual(endpoint, displayName.trim(), temporary, fingerprint.ifBlank { null }, confirmInsecure)
      },
      enabled = endpointReady && displayName.isNotBlank() && bearer.isNotBlank(),
    ) {
      Text("Register host")
    }

    PiDroidSectionTitle(
      title = "Import a pairing envelope",
      subtitle = "Paste a reviewed pidroid pairing envelope instead of entering fields manually.",
    )
    OutlinedTextField(
      value = envelope,
      onValueChange = {
        envelope = it.take(16_384)
        confirmEnvelopeInsecure = false
      },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Pairing envelope" },
      label = { Text("pidroid://pair/v1/…") },
      minLines = 3,
    )
    CleartextEnvelopeAcknowledgement(
      checked = confirmEnvelopeInsecure,
      onCheckedChange = { confirmEnvelopeInsecure = it },
    )
    OutlinedButton(
      modifier = Modifier.heightIn(min = 48.dp),
      onClick = {
        val submitted = envelope
        envelope = ""
        onRegisterEnvelope(submitted, confirmEnvelopeInsecure)
      },
      enabled = envelope.startsWith("pidroid://pair/v1/"),
    ) {
      Text("Import pairing envelope")
    }
  }
}

@Composable
private fun HostManagementNoticeCard(
  state: HostManagementState,
  onClearNotice: () -> Unit,
) {
  val notice = state.notice ?: return
  val (text, tone) =
    when (notice) {
      is HostManagementNotice.Added -> {
        "Host added. It is now available to select." to PiDroidStatusTone.POSITIVE
      }

      is HostManagementNotice.Updated -> {
        "Host details updated and the old connection was invalidated." to PiDroidStatusTone.POSITIVE
      }

      is HostManagementNotice.Repaired -> {
        "Credentials replaced. Cached authority and connections were invalidated." to
          PiDroidStatusTone.POSITIVE
      }

      is HostManagementNotice.Forgotten -> {
        "${notice.displayName} was forgotten. Other hosts were preserved." to PiDroidStatusTone.POSITIVE
      }

      is HostManagementNotice.DuplicateEndpoint -> {
        val name = state.hosts.firstOrNull { it.id == notice.hostId }?.displayName ?: "This host"
        "$name already uses that endpoint. Review it below and explicitly replace credentials to update it." to PiDroidStatusTone.WARNING
      }

      is HostManagementNotice.Failure -> {
        "Host change failed safely · ${notice.code.uppercase()}" to PiDroidStatusTone.ERROR
      }
    }
  Surface(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    color = MaterialTheme.colorScheme.surfaceVariant,
    shape = MaterialTheme.shapes.medium,
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(12.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      PiDroidStatusChip("Notice", tone)
      Text(text, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
      TextButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onClearNotice) { Text("Dismiss") }
    }
  }
}

@Composable
private fun HostCard(
  host: RegisteredHost,
  readiness: String,
  isDefault: Boolean,
  onSelectDefault: () -> Unit,
  onEdit: () -> Unit,
  onRepair: () -> Unit,
  onForget: () -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = MaterialTheme.colorScheme.surface,
    shape = MaterialTheme.shapes.large,
    border =
      BorderStroke(
        1.dp,
        if (isDefault) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline.copy(alpha = 0.55f),
      ),
  ) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(host.displayName, color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.Bold)
          Text(host.baseUri.toASCIIString(), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
        PiDroidStatusChip(
          readiness,
          if (readiness == "READY") PiDroidStatusTone.POSITIVE else PiDroidStatusTone.WARNING,
        )
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        PiDroidStatusChip(hostSecurityLabel(host), PiDroidStatusTone.INFO)
        if (isDefault) PiDroidStatusChip("Default", PiDroidStatusTone.MUTED)
      }
      FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        if (!isDefault) {
          OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onSelectDefault) { Text("Make default") }
        }
        OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onEdit) { Text("Edit") }
        OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onRepair) { Text("Re-pair") }
        TextButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onForget) {
          Text("Forget", color = MaterialTheme.colorScheme.error)
        }
      }
    }
  }
}

@Composable
private fun HostEditor(
  host: RegisteredHost,
  replaceCredential: Boolean,
  onBack: () -> Unit,
  onUpdateHost: (HostId, String, String, String?, Boolean) -> Unit,
  onReplaceHost: (HostId, String, String, CharArray, String?, Boolean) -> Unit,
  onReplaceHostEnvelope: (HostId, String, Boolean) -> Unit,
) {
  var endpoint by remember(host.id, replaceCredential) { mutableStateOf(host.baseUri.toASCIIString()) }
  var displayName by remember(host.id.value, replaceCredential) { mutableStateOf(host.displayName) }
  var fingerprint by remember(host.id.value, replaceCredential) { mutableStateOf(host.tlsFingerprint.orEmpty()) }
  var bearer by remember(host.id, replaceCredential) { mutableStateOf("") }
  var envelope by remember(host.id, replaceCredential) { mutableStateOf("") }
  var confirmInsecure by remember(host.id, replaceCredential) {
    mutableStateOf(host.transportSecurity == TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT)
  }
  var confirmEnvelopeInsecure by remember(host.id, replaceCredential) { mutableStateOf(false) }
  val focus = LocalFocusManager.current
  val assessment = PiDroidEndpointPolicy.assess(endpoint)
  val endpointReady = assessment.canConnect && (!assessment.requiresCleartextAcknowledgement || confirmInsecure)

  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    TextButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onBack) { Text("Back to hosts") }
    PiDroidSectionTitle(
      eyebrow = if (replaceCredential) "Re-pair" else "Edit host",
      title = host.displayName,
      subtitle =
        if (replaceCredential) {
          "Replace metadata and the encrypted bearer atomically. Other hosts remain isolated."
        } else {
          "Change non-secret connection details. The current encrypted bearer stays sealed."
        },
    )
    OutlinedTextField(
      value = endpoint,
      onValueChange = {
        endpoint = it.take(2_048)
        confirmInsecure = false
      },
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Pi Daemon API URL" },
      label = { Text("API URL") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
      keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
      singleLine = true,
    )
    PiDroidEndpointSecurityCard(
      assessment = assessment,
      acknowledged = confirmInsecure,
      onAcknowledgedChange = { confirmInsecure = it },
    )
    OutlinedTextField(
      value = displayName,
      onValueChange = { displayName = it.take(128) },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Host name") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
      keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
      singleLine = true,
    )
    OutlinedTextField(
      value = fingerprint,
      onValueChange = { fingerprint = it.take(95).uppercase() },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Optional certificate SHA-256") },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
      keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
      singleLine = true,
    )

    if (!replaceCredential) {
      Button(
        modifier = Modifier.heightIn(min = 48.dp),
        onClick = {
          focus.clearFocus()
          onUpdateHost(host.id, endpoint, displayName.trim(), fingerprint.ifBlank { null }, confirmInsecure)
          onBack()
        },
        enabled = endpointReady && displayName.isNotBlank(),
      ) { Text("Save host details") }
    } else {
      OutlinedTextField(
        value = bearer,
        onValueChange = { bearer = it.take(4_096) },
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Replacement service bearer" },
        label = { Text("New service bearer") },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
        singleLine = true,
      )
      Text(
        "The replacement bearer is cleared from the form immediately and is never shown again.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Button(
        modifier = Modifier.heightIn(min = 48.dp),
        onClick = {
          focus.clearFocus()
          val temporary = bearer.toCharArray()
          bearer = ""
          onReplaceHost(host.id, endpoint, displayName.trim(), temporary, fingerprint.ifBlank { null }, confirmInsecure)
          onBack()
        },
        enabled = endpointReady && displayName.isNotBlank() && bearer.isNotBlank(),
      ) { Text("Replace credentials") }

      PiDroidSectionTitle(
        title = "Use a fresh pairing envelope",
        subtitle = "The replacement commits atomically and invalidates the old authority.",
      )
      OutlinedTextField(
        value = envelope,
        onValueChange = {
          envelope = it.take(16_384)
          confirmEnvelopeInsecure = false
        },
        modifier = Modifier.fillMaxWidth(),
        label = { Text("pidroid://pair/v1/…") },
        minLines = 3,
      )
      CleartextEnvelopeAcknowledgement(
        checked = confirmEnvelopeInsecure,
        onCheckedChange = { confirmEnvelopeInsecure = it },
      )
      OutlinedButton(
        modifier = Modifier.heightIn(min = 48.dp),
        onClick = {
          val submitted = envelope
          envelope = ""
          onReplaceHostEnvelope(host.id, submitted, confirmEnvelopeInsecure)
          onBack()
        },
        enabled = envelope.startsWith("pidroid://pair/v1/"),
      ) { Text("Replace from envelope") }
    }
  }
}

@Composable
private fun CleartextEnvelopeAcknowledgement(
  checked: Boolean,
  onCheckedChange: (Boolean) -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.58f),
    shape = MaterialTheme.shapes.medium,
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Checkbox(
        checked = checked,
        onCheckedChange = onCheckedChange,
        modifier = Modifier.semantics { contentDescription = "Allow remote HTTP from pairing envelope" },
      )
      Spacer(Modifier.width(8.dp))
      Column(Modifier.weight(1f)) {
        Text("Remote HTTP needs explicit approval", color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)
        Text(
          "Enable only after confirming the envelope names a trusted private-network endpoint. HTTPS and loopback do not require it.",
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          style = MaterialTheme.typography.bodySmall,
        )
      }
    }
  }
}

@Composable
private fun MissingHostState(
  onBack: () -> Unit,
  onAdd: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    PiDroidSectionTitle(
      title = "Host no longer registered",
      subtitle = "Choose another host or add it again. No other host was removed.",
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = onBack) { Text("Choose a host") }
      Button(modifier = Modifier.heightIn(min = 48.dp), onClick = onAdd) { Text("Add host") }
    }
  }
}
