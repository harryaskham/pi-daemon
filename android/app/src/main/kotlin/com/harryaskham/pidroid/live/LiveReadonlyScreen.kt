package com.harryaskham.pidroid.live

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sessionui.SessionSurface
import com.harryaskham.pidroid.sessionui.SessionSurfaceChrome
import com.harryaskham.pidroid.sessionui.SessionSurfaceLayout

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
  onRegisterManual: (String, String, CharArray, String?, Boolean) -> Unit,
  onRegisterEnvelope: (String, Boolean) -> Unit,
  onRefresh: () -> Unit,
  onSelectHost: (HostId) -> Unit,
) {
  MaterialTheme {
    Surface(modifier = Modifier.fillMaxSize(), color = LiveCanvas) {
      when (state) {
        LiveReadonlyState.Unconfigured -> {
          HostRegistrationScreen(onRegisterManual, onRegisterEnvelope)
        }

        is LiveReadonlyState.Loading -> {
          StatusScreen("Connecting", state.message, LiveAccent, onRefresh)
        }

        is LiveReadonlyState.Failure -> {
          StatusScreen("Host unavailable", state.code, LiveWarning, onRefresh)
        }

        is LiveReadonlyState.Ready -> {
          LiveSessionScreen(state, onRefresh, onSelectHost)
        }
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
      "Version 2 is readonly: capabilities, inventory, information and transcript. No prompt, wake or controller authority.",
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
      Text("Register and verify readonly host")
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

@Composable
private fun LiveSessionScreen(
  ready: LiveReadonlyState.Ready,
  onRefresh: () -> Unit,
  onSelectHost: (HostId) -> Unit,
) {
  Column(Modifier.fillMaxSize()) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      OutlinedButton(
        onClick = onRefresh,
        modifier = Modifier.semantics { contentDescription = "Refresh readonly hosts" },
      ) {
        Text("Refresh")
      }
      ready.hosts.forEach { snapshot ->
        val selected = snapshot.host.id == ready.selectedHostId
        OutlinedButton(onClick = { onSelectHost(snapshot.host.id) }) {
          Text(snapshot.host.displayName, color = if (selected) LiveAccent else LiveMuted)
        }
      }
      Spacer(Modifier.weight(1f))
      Text(
        if (ready.selected.rpcObserverConnected) "READONLY RPC ATTACHED" else "READONLY REST",
        color = if (ready.selected.rpcObserverConnected) LiveGreen else LiveWarning,
        fontWeight = FontWeight.Bold,
      )
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
      val fontScale = LocalDensity.current.fontScale
      val layout =
        if (maxWidth < 720.dp) {
          SessionSurfaceLayout.phone(fontScale)
        } else {
          SessionSurfaceLayout.tablet(fontScale)
        }
      SessionSurface(
        state = ready.selected.session,
        layout = layout,
        chrome = SessionSurfaceChrome.READONLY,
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

@Composable
private fun StatusScreen(
  title: String,
  detail: String,
  accent: Color,
  onRefresh: () -> Unit,
) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(title, color = LivePrimary, style = MaterialTheme.typography.headlineMedium)
      Text(detail, color = accent)
      Text("Live readonly session", color = LiveMuted, fontWeight = FontWeight.Bold)
      Button(onClick = onRefresh) { Text("Retry") }
    }
  }
}
