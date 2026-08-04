package com.harryaskham.pidroid.sdk.consumer.sample

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.NeutralHttpRequest
import com.harryaskham.pidroid.sdk.core.NeutralHttpResponse
import com.harryaskham.pidroid.sdk.core.NeutralWebSocketRequest
import com.harryaskham.pidroid.sdk.core.PiDaemonHostDescriptor
import com.harryaskham.pidroid.sdk.core.PiDaemonSocket
import com.harryaskham.pidroid.sdk.core.PiDaemonTransport
import com.harryaskham.pidroid.sessionui.SessionSurface
import com.harryaskham.pidroid.sessionui.SessionSurfaceChrome
import com.harryaskham.pidroid.sessionui.SessionSurfaceLayout
import com.harryaskham.pidroid.sessionui.SessionSurfaceState
import com.harryaskham.pidroid.workspace.PiDroidWorkspaceShell
import com.harryaskham.pidroid.workspace.WorkspaceShellAction
import com.harryaskham.pidroid.workspace.WorkspaceShellFixture
import com.harryaskham.pidroid.workspace.WorkspaceShellLayout
import com.harryaskham.pidroid.workspace.WorkspaceShellState
import kotlinx.coroutines.flow.Flow

/**
 * The embedding application injects an authenticated transport implementation. This sample never
 * owns, requests, exposes, copies, or persists authentication material.
 */
public class InjectedSdkConsumer(
  private val transport: PiDaemonTransport,
) {
  public val hosts: Flow<List<PiDaemonHostDescriptor>>
    get() = transport.hosts

  public suspend fun execute(
    host: HostId,
    request: NeutralHttpRequest,
  ): NeutralHttpResponse = transport.execute(host, request)

  public fun openWebSocket(
    host: HostId,
    request: NeutralWebSocketRequest,
  ): PiDaemonSocket = transport.openWebSocket(host, request)
}

@Composable
public fun CanonicalSessionContent(
  state: SessionSurfaceState,
  layout: SessionSurfaceLayout,
  chrome: SessionSurfaceChrome,
  modifier: Modifier = Modifier,
) {
  SessionSurface(
    state = state,
    layout = layout,
    modifier = modifier,
    chrome = chrome,
  )
}

@Composable
public fun CanonicalWorkspaceContent(
  fixture: WorkspaceShellFixture,
  layout: WorkspaceShellLayout,
  state: WorkspaceShellState,
  modifier: Modifier = Modifier,
  onAction: (WorkspaceShellAction) -> Unit = {},
) {
  PiDroidWorkspaceShell(
    fixture = fixture,
    layout = layout,
    state = state,
    modifier = modifier,
    onAction = onAction,
  )
}
