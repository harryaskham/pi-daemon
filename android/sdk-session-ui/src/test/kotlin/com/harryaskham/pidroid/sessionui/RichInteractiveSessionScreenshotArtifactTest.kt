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
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class RichInteractiveSessionScreenshotArtifactTest {
  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `render exact interactive phone and tablet fixtures when requested`() {
    val output = System.getenv(OUTPUT_ENV)?.takeIf(String::isNotBlank)?.let(Path::of) ?: return
    Files.createDirectories(output)

    for (profile in InteractiveScreenshotProfiles.all) {
      runDesktopComposeUiTest(width = profile.widthPx, height = profile.heightPx) {
        setContent {
          Box(Modifier.fillMaxSize().testTag(CAPTURE_TAG)) {
            RichInteractiveSessionSurface(
              session = SessionSurfaceTestFixtures.state(profile.freshness, profile.observedAgeMillis),
              interactive = profile.interactive,
              layout = profile.layout,
            )
          }
        }
        waitForIdle()
        val bitmap = onNodeWithTag(CAPTURE_TAG).captureToImage().asSkiaBitmap()
        val data =
          Image.makeFromBitmap(bitmap).encodeToData(EncodedImageFormat.PNG)
            ?: error("failed to encode ${profile.id} interactive fixture")
        Files.write(output.resolve("interactive-${profile.id}.png"), data.bytes)
      }
    }
  }

  private companion object {
    const val OUTPUT_ENV: String = "PI_DROID_INTERACTIVE_SCREENSHOT_DIR"
    const val CAPTURE_TAG: String = "pi-droid-interactive-capture"
  }
}
