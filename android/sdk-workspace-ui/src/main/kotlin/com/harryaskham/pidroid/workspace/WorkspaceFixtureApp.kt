package com.harryaskham.pidroid.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState

public fun main(args: Array<String>): Unit =
  application {
    val profile = WorkspaceScreenshotFixtures.profile(args.firstOrNull() ?: "tablet")
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val exitAfterFrame = System.getenv("PI_DROID_FIXTURE_EXIT_AFTER_FRAME") == "1"
    var shellState by
      remember(profile.id) {
        mutableStateOf(
          WorkspaceShellState(
            document = fixture.document,
            sidebarExpanded = profile.sidebarExpanded,
          ),
        )
      }
    val windowState =
      rememberWindowState(
        width = profile.windowWidthPx.dp,
        height = profile.windowHeightPx.dp,
      )

    Window(
      onCloseRequest = ::exitApplication,
      state = windowState,
      title = profile.title,
    ) {
      WorkspaceRenderDiagnostics(
        profileId = profile.id,
        onMeasured = { if (exitAfterFrame) exitApplication() },
      )
      PiDroidWorkspaceShell(
        fixture = fixture,
        layout = WorkspaceAdaptivePolicy.resolve(profile.viewport),
        state = shellState,
        onAction = { action -> shellState = WorkspaceShellReducer.reduce(shellState, action) },
      )
    }
  }

@Composable
private fun WorkspaceRenderDiagnostics(
  profileId: String,
  onMeasured: () -> Unit,
) {
  val enabled = remember { System.getenv("PI_DROID_FIXTURE_DIAGNOSTICS") == "1" }
  if (!enabled) {
    return
  }
  val startedAt = remember { System.nanoTime() }
  var recompositions by remember { mutableIntStateOf(0) }
  SideEffect { recompositions += 1 }
  LaunchedEffect(profileId) {
    withFrameNanos { }
    val elapsedMs = (System.nanoTime() - startedAt).coerceAtLeast(0) / 1_000_000.0
    println(
      "pi-droid-fixture profile=$profileId firstFrameMs=${"%.3f".format(elapsedMs)} recompositions=$recompositions measurement=opt-in",
    )
    onMeasured()
  }
}
