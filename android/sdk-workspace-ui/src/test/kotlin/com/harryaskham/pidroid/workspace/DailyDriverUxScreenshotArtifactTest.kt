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
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.nio.file.Files
import java.nio.file.Path
import javax.imageio.ImageIO

class DailyDriverUxScreenshotArtifactTest {
  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `render bounded daily driver proof when artifact output is requested`() {
    val output = System.getenv(OUTPUT_ENV)?.takeIf(String::isNotBlank)?.let(Path::of) ?: return
    Files.createDirectories(output)

    PiDroidDailyDriverScreenshotFixtures.all.forEach { profile ->
      runDesktopComposeUiTest(
        width = profile.windowWidthPx,
        height = profile.windowHeightPx,
      ) {
        setContent {
          Box(Modifier.fillMaxSize().testTag(CAPTURE_TAG)) {
            PiDroidDailyDriverShowcase(profile)
          }
        }
        waitForIdle()
        val bitmap = onNodeWithTag(CAPTURE_TAG).captureToImage().asSkiaBitmap()
        val data =
          Image.makeFromBitmap(bitmap).encodeToData(EncodedImageFormat.PNG)
            ?: error("failed to encode ${profile.id} daily-driver fixture")
        Files.write(output.resolve("daily-driver-${profile.id}.png"), data.bytes)
      }
    }
    writeContactSheet(output)
  }

  private fun writeContactSheet(output: Path) {
    val profiles = PiDroidDailyDriverScreenshotFixtures.all
    val cellWidth = 640
    val cellHeight = 540
    val gap = 18
    val image = BufferedImage(cellWidth * 2 + gap * 3, cellHeight * 2 + gap * 3, BufferedImage.TYPE_INT_RGB)
    val graphics = image.createGraphics()
    try {
      graphics.color = Color(0x0B, 0x10, 0x18)
      graphics.fillRect(0, 0, image.width, image.height)
      graphics.color = Color(0x88, 0xCF, 0xE0)
      graphics.font = Font(Font.SANS_SERIF, Font.BOLD, 14)
      graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC)
      profiles.forEachIndexed { index, profile ->
        val source = ImageIO.read(output.resolve("daily-driver-${profile.id}.png").toFile())
        val scale = minOf(cellWidth.toDouble() / source.width, (cellHeight - 34).toDouble() / source.height, 1.0)
        val width = (source.width * scale).toInt()
        val height = (source.height * scale).toInt()
        val cellX = gap + (index % 2) * (cellWidth + gap)
        val cellY = gap + (index / 2) * (cellHeight + gap)
        val x = cellX + (cellWidth - width) / 2
        val y = cellY + 30 + (cellHeight - 30 - height) / 2
        graphics.drawString(profile.id.uppercase(), cellX, cellY + 14)
        graphics.drawImage(source, x, y, width, height, null)
      }
    } finally {
      graphics.dispose()
    }
    check(ImageIO.write(image, "png", output.resolve("daily-driver-contact-sheet.png").toFile())) {
      "failed to encode daily-driver contact sheet"
    }
  }

  private companion object {
    const val OUTPUT_ENV: String = "PI_DROID_DAILY_DRIVER_SCREENSHOT_DIR"
    const val CAPTURE_TAG: String = "pi-droid-daily-driver-capture"
  }
}
