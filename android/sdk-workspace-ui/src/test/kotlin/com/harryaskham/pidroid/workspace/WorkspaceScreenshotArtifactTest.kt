package com.harryaskham.pidroid.workspace

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.v2.runDesktopComposeUiTest
import org.jetbrains.skia.EncodedImageFormat
import org.jetbrains.skia.Image
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class WorkspaceScreenshotArtifactTest {
  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `render exact named screenshot profiles when artifact output is requested`() {
    val output = System.getenv(OUTPUT_ENV)?.takeIf(String::isNotBlank)?.let(Path::of) ?: return
    Files.createDirectories(output)
    val fixture = WorkspaceShellFixtures.nestedWorkspace()

    WorkspaceScreenshotFixtures.all
      .filter { it.id in CAPTURE_PROFILE_IDS }
      .forEach { profile ->
        runDesktopComposeUiTest(
          width = profile.windowWidthPx,
          height = profile.windowHeightPx,
        ) {
          setContent {
            Box(Modifier.fillMaxSize().testTag(CAPTURE_TAG)) {
              PiDroidWorkspaceShell(
                fixture = fixture,
                layout = WorkspaceAdaptivePolicy.resolve(profile.viewport),
                state =
                  WorkspaceShellState(
                    document = fixture.document,
                    sidebarExpanded = profile.sidebarExpanded,
                  ),
              )
            }
          }
          waitForIdle()
          val bitmap = onNodeWithTag(CAPTURE_TAG).captureToImage().asSkiaBitmap()
          val data =
            Image.makeFromBitmap(bitmap).encodeToData(EncodedImageFormat.PNG)
              ?: error("failed to encode ${profile.id} workspace fixture")
          Files.write(output.resolve("workspace-${profile.id}.png"), data.bytes)
        }
      }
  }

  private companion object {
    const val OUTPUT_ENV: String = "PI_DROID_SCREENSHOT_DIR"
    const val CAPTURE_TAG: String = "pi-droid-workspace-capture"
    val CAPTURE_PROFILE_IDS: Set<String> = setOf("phone", "tablet", "foldable", "nested")
  }
}
