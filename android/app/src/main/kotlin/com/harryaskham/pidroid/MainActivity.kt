package com.harryaskham.pidroid

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.lifecycleScope
import com.harryaskham.pidroid.live.AndroidHostRegistry
import com.harryaskham.pidroid.live.LiveReadonlyRepository
import com.harryaskham.pidroid.live.LiveReadonlyScreen
import com.harryaskham.pidroid.live.OkHttpPiDaemonTransport
import com.harryaskham.pidroid.sdk.core.CommandAdmissionException
import com.harryaskham.pidroid.sdk.core.PairingPayloadCodec
import kotlinx.coroutines.launch
import java.net.URI

class MainActivity : ComponentActivity() {
  private lateinit var repository: LiveReadonlyRepository

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    val hosts = AndroidHostRegistry(this)
    repository =
      LiveReadonlyRepository(
        registry = hosts.registry,
        credentials = hosts.credentialVault,
        transport = OkHttpPiDaemonTransport(),
      )

    lifecycleScope.launch {
      repository.initialize()
      intent?.dataString?.takeIf { it.startsWith(PAIRING_PREFIX) }?.let { registerEnvelope(it) }
    }

    setContent {
      val state by repository.state.collectAsState()
      val interaction by repository.interactiveState.collectAsState()
      LiveReadonlyScreen(
        state = state,
        interaction = interaction,
        onRegisterManual = { endpoint, displayName, bearer, fingerprint, confirmInsecure ->
          lifecycleScope.launch {
            runCatching {
              repository.registerManual(
                apiUri = URI(endpoint),
                displayName = displayName,
                bearer = bearer,
                tlsFingerprint = fingerprint,
                confirmInsecureHttp = confirmInsecure,
              )
            }.onFailure { repository.reportFailure(safeCode(it)) }
          }
        },
        onRegisterEnvelope = { envelope, confirmInsecure ->
          lifecycleScope.launch {
            runCatching { repository.registerEnvelope(envelope, confirmInsecure) }
              .onFailure { repository.reportFailure(safeCode(it)) }
          }
        },
        onRefresh = {
          lifecycleScope.launch {
            runCatching { repository.refresh() }
              .onFailure { repository.reportFailure(safeCode(it)) }
          }
        },
        onSelectHost = repository::selectHost,
        onConnectInteractive = {
          lifecycleScope.launch {
            runCatching { repository.connectInteractiveObserver() }
              .onFailure { repository.reportInteractiveFailure(safeInteractiveFailureCode(it)) }
          }
        },
        onInteractiveAction = { action ->
          lifecycleScope.launch {
            runCatching { repository.handleInteraction(action) }
              .onFailure { repository.reportInteractiveFailure(safeInteractiveFailureCode(it)) }
          }
        },
        onReconnectInteractive = {
          lifecycleScope.launch {
            runCatching { repository.reconnectInteractive() }
              .onFailure { repository.reportInteractiveFailure(safeInteractiveFailureCode(it)) }
          }
        },
      )
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    intent.dataString?.takeIf { it.startsWith(PAIRING_PREFIX) }?.let { envelope ->
      lifecycleScope.launch { registerEnvelope(envelope) }
    }
  }

  override fun onDestroy() {
    repository.close()
    super.onDestroy()
  }

  private suspend fun registerEnvelope(envelope: String) {
    val debugMetadata =
      packageManager
        .getApplicationInfo(
          packageName,
          PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
        ).metaData
    val allowDisposableBridge =
      debugMetadata?.getBoolean(DISPOSABLE_EMULATOR_METADATA, false) == true &&
        runCatching {
          PairingPayloadCodec.decode(envelope).use { payload -> payload.apiUri.host == "10.0.2.2" }
        }.getOrDefault(false)
    runCatching { repository.registerEnvelope(envelope, confirmInsecureHttp = allowDisposableBridge) }
      .onFailure { repository.reportFailure(safeCode(it)) }
  }

  private fun safeCode(error: Throwable): String =
    when (error) {
      is CommandAdmissionException -> {
        error.code
      }

      is com.harryaskham.pidroid.live.LiveReadonlyFailure -> {
        error.code
      }

      is com.harryaskham.pidroid.live.TransportFailure -> {
        error.code
      }

      is com.harryaskham.pidroid.sdk.core.PairingPayloadException -> {
        error.code
      }

      is com.harryaskham.pidroid.sdk.core.ProtocolDecodeException -> {
        error.code
      }

      is com.harryaskham.pidroid.sessionui.SessionFixtureException -> {
        error.code
      }

      is IllegalArgumentException -> {
        error.message
          ?.take(96)
          ?.replace(Regex("[^A-Za-z0-9 _.-]"), "_")
          ?.let { "invalid_registration: $it" }
          ?: "invalid_registration"
      }

      else -> {
        "host_unavailable"
      }
    }

  private companion object {
    const val PAIRING_PREFIX: String = "pidroid://pair/v1/"
    const val DISPOSABLE_EMULATOR_METADATA: String = "com.harryaskham.pidroid.ALLOW_DISPOSABLE_EMULATOR_BRIDGE"
  }
}

private val INTERACTIVE_FAILURE_CODE = Regex("^[a-z][a-z0-9_]{0,127}$")

internal fun safeInteractiveFailureCode(error: Throwable): String {
  val candidate =
    when (error) {
      is CommandAdmissionException -> error.code
      is com.harryaskham.pidroid.live.LiveReadonlyFailure -> error.code
      is com.harryaskham.pidroid.live.TransportFailure -> error.code
      is com.harryaskham.pidroid.sdk.core.ProtocolDecodeException -> error.code
      else -> return "interactive_failed"
    }
  return candidate.takeIf(INTERACTIVE_FAILURE_CODE::matches) ?: "interactive_failed"
}
