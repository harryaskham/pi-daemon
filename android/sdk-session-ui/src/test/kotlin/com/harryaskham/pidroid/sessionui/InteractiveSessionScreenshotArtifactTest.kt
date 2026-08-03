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

class InteractiveSessionScreenshotArtifactTest {
  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `render exact phone tree and tablet extension proofs when requested`() {
    val output = System.getenv(OUTPUT_ENV)?.takeIf(String::isNotBlank)?.let(Path::of) ?: return
    Files.createDirectories(output)

    capture(output, "tree-phone", 430, 932) {
      SessionTreeSurface(
        snapshot = InteractiveSessionTestFixtures.tree(),
        context = InteractiveSessionTestFixtures.context(),
      )
    }
    capture(output, "extension-tablet", 1_280, 800) {
      DeclarativeExtensionSurface(
        view = InteractiveSessionTestFixtures.extensionView(),
        context = InteractiveSessionTestFixtures.context(),
        formValues = InteractiveSessionTestFixtures.completeFormValues(),
      )
    }
  }

  @OptIn(ExperimentalTestApi::class)
  private fun capture(
    output: Path,
    id: String,
    width: Int,
    height: Int,
    content: @androidx.compose.runtime.Composable () -> Unit,
  ) {
    runDesktopComposeUiTest(width = width, height = height) {
      setContent {
        Box(Modifier.fillMaxSize().testTag(CAPTURE_TAG)) { content() }
      }
      waitForIdle()
      val bitmap = onNodeWithTag(CAPTURE_TAG).captureToImage().asSkiaBitmap()
      assertEquals(width, bitmap.width)
      assertEquals(height, bitmap.height)
      val data =
        Image.makeFromBitmap(bitmap).encodeToData(EncodedImageFormat.PNG)
          ?: error("failed to encode $id interactive session fixture")
      Files.write(output.resolve("session-interactive-$id.png"), data.bytes)
    }
  }

  private companion object {
    const val OUTPUT_ENV: String = "PI_DROID_STAGE_C_SCREENSHOT_DIR"
    const val CAPTURE_TAG: String = "pi-droid-stage-c-capture"
  }
}
