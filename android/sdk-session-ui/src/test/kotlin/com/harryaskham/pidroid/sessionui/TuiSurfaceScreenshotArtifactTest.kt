package com.harryaskham.pidroid.sessionui

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
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class TuiSurfaceScreenshotArtifactTest {
  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `render exact phone and tablet terminal screenshots when requested`() {
    val output = System.getenv(OUTPUT_ENV)?.takeIf(String::isNotBlank)?.let(Path::of) ?: return
    Files.createDirectories(output)

    for (profile in TuiScreenshotProfiles.all) {
      runDesktopComposeUiTest(
        width = profile.windowWidthPx,
        height = profile.windowHeightPx,
      ) {
        setContent {
          Box(Modifier.fillMaxSize().testTag(CAPTURE_TAG)) {
            TuiSurface(
              state =
                if (profile.role == TuiControlRole.CONTROLLER) {
                  TuiSurfaceTestFixtures.controllerState()
                } else {
                  TuiSurfaceTestFixtures.observerState()
                },
              layout = profile.layout,
            )
          }
        }
        waitForIdle()
        val bitmap = onNodeWithTag(CAPTURE_TAG).captureToImage().asSkiaBitmap()
        assertEquals(profile.windowWidthPx, bitmap.width)
        assertEquals(profile.windowHeightPx, bitmap.height)
        val data =
          Image.makeFromBitmap(bitmap).encodeToData(EncodedImageFormat.PNG)
            ?: error("failed to encode ${profile.id} terminal fixture")
        Files.write(output.resolve("tui-${profile.id}.png"), data.bytes)
      }
    }
  }

  private companion object {
    const val OUTPUT_ENV: String = "PI_DROID_TUI_SCREENSHOT_DIR"
    const val CAPTURE_TAG: String = "pi-droid-tui-surface-capture"
  }
}
