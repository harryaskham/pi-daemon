package com.harryaskham.pidroid.live

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.RegisteredHost
import com.harryaskham.pidroid.sdk.core.TransportSecurity

private val HostsCanvas = Color(0xFF0C111B)
private val HostsSurface = Color(0xFF121A28)
private val HostsSurfaceRaised = Color(0xFF182235)
private val HostsPrimary = Color(0xFFE8EEF7)
private val HostsMuted = Color(0xFF91A0B7)
private val HostsAccent = Color(0xFF82D2E5)
private val HostsGreen = Color(0xFFA8D8A0)
private val HostsWarning = Color(0xFFE7C987)
private val HostsDanger = Color(0xFFE89A9A)
private val HostsBorder = Color(0xFF2A3952)

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
  var selectedHostId by remember { mutableStateOf<HostId?>(null) }
  var pendingForget by remember { mutableStateOf<HostId?>(null) }

  LaunchedEffect(state.hosts, state.notice) {
    val duplicate = state.notice as? HostManagementNotice.DuplicateEndpoint
    when {
      duplicate != null && state.hosts.any { it.id == duplicate.hostId } -> {
        selectedHostId = duplicate.hostId
        mode = HostManagementMode.REPAIR
      }

      state.notice is HostManagementNotice.Added -> {
        selectedHostId = null
        mode = HostManagementMode.LIST
      }

      state.hosts.isEmpty() -> {
        selectedHostId = null
        mode = HostManagementMode.ADD
      }

      selectedHostId != null && state.hosts.none { it.id == selectedHostId } -> {
        selectedHostId = null
        mode = HostManagementMode.LIST
      }
    }
  }

  Surface(modifier = Modifier.fillMaxSize(), color = HostsCanvas) {
    Column(Modifier.fillMaxSize()) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Column {
          Text("PI DROID", color = HostsAccent, fontWeight = FontWeight.Black)
          Text("Hosts", color = HostsPrimary, style = MaterialTheme.typography.headlineSmall)
        }
        Spacer(Modifier.weight(1f))
        if (state.hosts.isNotEmpty()) {
          TextButton(onClick = onClose) { Text("Done") }
        }
      }

      HostManagementNoticeCard(state, onClearNotice)

      when (mode) {
        HostManagementMode.ADD -> {
          if (state.hosts.isNotEmpty()) {
            TextButton(
              onClick = { mode = HostManagementMode.LIST },
              modifier = Modifier.padding(horizontal = 16.dp),
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
              onBack = {
                selectedHostId = null
                mode = HostManagementMode.LIST
              },
              onAdd = { mode = HostManagementMode.ADD },
            )
          } else {
            HostEditor(
              host = selected,
              replaceCredential = mode == HostManagementMode.REPAIR,
              onBack = { mode = HostManagementMode.LIST },
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
              "Servers stay isolated. Editing or re-pairing one host never changes another host or workspace.",
              color = HostsMuted,
            )
            state.hosts.forEach { host ->
              HostCard(
                host = host,
                readiness = hostReadinessLabel(host.id, liveState),
                isDefault = state.defaultHostId == host.id,
                onSelectDefault = { onSelectDefault(host.id) },
                onEdit = {
                  selectedHostId = host.id
                  mode = HostManagementMode.EDIT
                },
                onRepair = {
                  selectedHostId = host.id
                  mode = HostManagementMode.REPAIR
                },
                onForget = { pendingForget = host.id },
              )
            }
            Button(
              onClick = { mode = HostManagementMode.ADD },
              modifier = Modifier.semantics { contentDescription = "Add another Pi Daemon host" },
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
          onClick = {
            pendingForget = null
            onForgetHost(forgotten.id)
          },
        ) { Text("Forget", color = HostsDanger) }
      },
      dismissButton = { TextButton(onClick = { pendingForget = null }) { Text("Cancel") } },
    )
  }
}

@Composable
private fun HostManagementNoticeCard(
  state: HostManagementState,
  onClearNotice: () -> Unit,
) {
  val notice = state.notice ?: return
  val (text, color) =
    when (notice) {
      is HostManagementNotice.Added -> {
        "Host added. It is now available to select." to HostsGreen
      }

      is HostManagementNotice.Updated -> {
        "Host details updated and the old connection was invalidated." to HostsGreen
      }

      is HostManagementNotice.Repaired -> {
        "Credentials replaced. Cached authority and connections were invalidated." to HostsGreen
      }

      is HostManagementNotice.Forgotten -> {
        "${notice.displayName} was forgotten. Other hosts were preserved." to HostsGreen
      }

      is HostManagementNotice.DuplicateEndpoint -> {
        val name = state.hosts.firstOrNull { it.id == notice.hostId }?.displayName ?: "This host"
        "$name already uses that endpoint. Review it below and explicitly replace credentials to update it." to HostsWarning
      }

      is HostManagementNotice.Failure -> {
        "Host change failed safely · ${notice.code.uppercase()}" to HostsDanger
      }
    }
  Surface(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    color = HostsSurfaceRaised,
    border = BorderStroke(1.dp, color),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(text, modifier = Modifier.weight(1f), color = color)
      TextButton(onClick = onClearNotice) { Text("Dismiss") }
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
    color = HostsSurface,
    border = BorderStroke(1.dp, if (isDefault) HostsAccent else HostsBorder),
  ) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(host.displayName, color = HostsPrimary, fontWeight = FontWeight.Bold)
          Text(host.baseUri.toASCIIString(), color = HostsMuted, style = MaterialTheme.typography.bodySmall)
        }
        Text(readiness, color = if (readiness == "READY") HostsGreen else HostsWarning, fontWeight = FontWeight.Bold)
      }
      Text(hostSecurityLabel(host), color = HostsMuted)
      FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        if (isDefault) {
          Text("DEFAULT", color = HostsAccent, fontWeight = FontWeight.Bold)
        } else {
          OutlinedButton(onClick = onSelectDefault) { Text("Make default") }
        }
        OutlinedButton(onClick = onEdit) { Text("Edit") }
        OutlinedButton(onClick = onRepair) { Text("Re-pair") }
        TextButton(onClick = onForget) { Text("Forget", color = HostsDanger) }
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
  var displayName by remember(host.id, replaceCredential) { mutableStateOf(host.displayName) }
  var fingerprint by remember(host.id, replaceCredential) { mutableStateOf(host.tlsFingerprint.orEmpty()) }
  var bearer by remember(host.id, replaceCredential) { mutableStateOf("") }
  var envelope by remember(host.id, replaceCredential) { mutableStateOf("") }
  var confirmInsecure by remember(host.id, replaceCredential) {
    mutableStateOf(host.transportSecurity == TransportSecurity.EXPLICIT_REMOTE_PLAINTEXT)
  }

  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    TextButton(onClick = onBack) { Text("Back to hosts") }
    Text(
      if (replaceCredential) "Re-pair ${host.displayName}" else "Edit ${host.displayName}",
      color = HostsPrimary,
      style = MaterialTheme.typography.headlineSmall,
    )
    Text(
      if (replaceCredential) {
        "Replace this host's metadata and encrypted bearer together. Nothing is sent over the network until the durable replacement commits."
      } else {
        "Change non-secret connection details. The current encrypted bearer stays sealed and is never displayed."
      },
      color = HostsMuted,
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
      value = fingerprint,
      onValueChange = { fingerprint = it.take(95).uppercase() },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Optional certificate SHA-256") },
      singleLine = true,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
      Checkbox(checked = confirmInsecure, onCheckedChange = { confirmInsecure = it })
      Spacer(Modifier.width(8.dp))
      Text("Allow this explicitly entered remote HTTP endpoint", color = HostsMuted)
    }

    if (!replaceCredential) {
      Button(
        onClick = {
          onUpdateHost(host.id, endpoint, displayName, fingerprint.ifBlank { null }, confirmInsecure)
          onBack()
        },
        enabled = endpoint.isNotBlank() && displayName.isNotBlank(),
      ) { Text("Save host details") }
    } else {
      OutlinedTextField(
        value = bearer,
        onValueChange = { bearer = it.take(4_096) },
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Replacement service bearer" },
        label = { Text("New service bearer") },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
      )
      Text("The replacement bearer is cleared from the form immediately and is never shown again.", color = HostsMuted)
      Button(
        onClick = {
          val temporary = bearer.toCharArray()
          bearer = ""
          onReplaceHost(host.id, endpoint, displayName, temporary, fingerprint.ifBlank { null }, confirmInsecure)
          onBack()
        },
        enabled = endpoint.isNotBlank() && displayName.isNotBlank() && bearer.isNotBlank(),
      ) { Text("Replace credentials") }

      Text("Or replace from a fresh pairing envelope", color = HostsPrimary, fontWeight = FontWeight.Bold)
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
          onReplaceHostEnvelope(host.id, submitted, confirmInsecure)
          onBack()
        },
        enabled = envelope.startsWith("pidroid://pair/v1/"),
      ) { Text("Replace from envelope") }
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
    Text("Host no longer registered", color = HostsPrimary, style = MaterialTheme.typography.headlineSmall)
    Text(
      "This view points to a missing host. Choose another registered host or add it again; no other host was removed.",
      color = HostsMuted,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(onClick = onBack) { Text("Choose a host") }
      Button(onClick = onAdd) { Text("Add host") }
    }
  }
}
