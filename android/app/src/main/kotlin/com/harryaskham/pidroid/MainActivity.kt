package com.harryaskham.pidroid

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import com.harryaskham.pidroid.workspace.PiDroidWorkspaceShell
import com.harryaskham.pidroid.workspace.WorkspaceAdaptivePolicy
import com.harryaskham.pidroid.workspace.WorkspacePersistence
import com.harryaskham.pidroid.workspace.WorkspaceRestoreResult
import com.harryaskham.pidroid.workspace.WorkspaceShellAction
import com.harryaskham.pidroid.workspace.WorkspaceShellFixtures
import com.harryaskham.pidroid.workspace.WorkspaceShellReducer
import com.harryaskham.pidroid.workspace.WorkspaceShellState
import com.harryaskham.pidroid.workspace.WorkspaceViewport

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val preferences = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
    val restored =
      preferences
        .getString(WORKSPACE_KEY, null)
        ?.let(WorkspacePersistence::restore)
        ?.let { result ->
          when (result) {
            is WorkspaceRestoreResult.Loaded -> result.document
            is WorkspaceRestoreResult.Quarantined -> result.fallback
          }
        } ?: fixture.document

    setContent {
      var shellState by remember {
        mutableStateOf(
          WorkspaceShellState(
            document = restored,
            sidebarExpanded = false,
          ),
        )
      }
      val density = LocalDensity.current

      BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val viewport =
          remember(maxWidth, maxHeight, density.fontScale) {
            WorkspaceViewport(
              widthDp = maxWidth.value.toInt().coerceAtLeast(1),
              heightDp = maxHeight.value.toInt().coerceAtLeast(1),
              fontScale = density.fontScale,
            )
          }
        PiDroidWorkspaceShell(
          fixture = fixture,
          layout = WorkspaceAdaptivePolicy.resolve(viewport),
          state = shellState,
          onAction = { action: WorkspaceShellAction ->
            val next = WorkspaceShellReducer.reduce(shellState, action)
            shellState = next
            preferences
              .edit()
              .putString(WORKSPACE_KEY, WorkspacePersistence.encode(next.document))
              .apply()
          },
        )
      }
    }
  }

  private companion object {
    const val PREFERENCES_NAME: String = "pi-droid-workspace"
    const val WORKSPACE_KEY: String = "workspace-v2"
  }
}
