package com.harryaskham.pidroid.integration

import com.harryaskham.pidroid.sdk.core.HostId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.nio.file.Files
import java.nio.file.Path
import javax.imageio.ImageIO

class NotificationStateScreenshotArtifactTest {
  @Test
  fun `render content safe notification state proof when requested`() {
    val output = System.getenv(OUTPUT_ENV)?.takeIf(String::isNotBlank)?.let(Path::of) ?: return
    Files.createDirectories(output)
    val session = MonitoredSession(HostId("fixture-host"), "host-instance", 1, "fixture-session", 2)
    val notifications =
      listOf(
        SessionNotificationSignalMapper.wakeQueued(session, "wake-01"),
        SessionNotificationSignalMapper.running(session, "running-01"),
        SessionNotificationSignalMapper.inputRequired(session, "input-01"),
        SessionNotificationSignalMapper.terminal(session, "terminal-01", true),
        SessionNotificationSignalMapper.hostDisconnected(session, "host-01"),
      ).map(ContentSafeNotificationProjector::project)

    val image = BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_ARGB)
    val graphics = image.createGraphics()
    try {
      graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
      graphics.color = Color(0x0D, 0x12, 0x1B)
      graphics.fillRect(0, 0, WIDTH, HEIGHT)
      graphics.color = Color(0xF2, 0xF6, 0xFC)
      graphics.font = Font(Font.SANS_SERIF, Font.BOLD, 23)
      graphics.drawString("Pi Droid notifications", 24, 46)
      graphics.color = Color(0xA9, 0xB5, 0xC7)
      graphics.font = Font(Font.SANS_SERIF, Font.PLAIN, 14)
      graphics.drawString("Content-safe state proof — no prompt or model output", 24, 72)

      notifications.forEachIndexed { index, notification ->
        val top = 98 + index * 150
        graphics.color = Color(0x1B, 0x24, 0x33)
        graphics.fillRoundRect(18, top, WIDTH - 36, 126, 24, 24)
        graphics.color = channelColor(notification.channel)
        graphics.fillRoundRect(32, top + 25, 10, 76, 8, 8)
        graphics.color = Color(0xF5, 0xF8, 0xFC)
        graphics.font = Font(Font.SANS_SERIF, Font.BOLD, 18)
        graphics.drawString(notification.title, 58, top + 50)
        graphics.color = Color(0xBF, 0xC9, 0xD8)
        graphics.font = Font(Font.SANS_SERIF, Font.PLAIN, 14)
        graphics.drawString(notification.body, 58, top + 79)
        graphics.color = Color(0x83, 0x91, 0xA5)
        graphics.font = Font(Font.MONOSPACED, Font.PLAIN, 12)
        graphics.drawString(notification.channel.wireName, 58, top + 103)
      }
    } finally {
      graphics.dispose()
    }

    val target = output.resolve("notification-state-phone.png")
    ImageIO.write(image, "png", target.toFile())
    ImageIO.read(target.toFile()).let {
      assertEquals(WIDTH, it.width)
      assertEquals(HEIGHT, it.height)
    }
  }

  private fun channelColor(channel: NotificationChannel): Color =
    when (channel) {
      NotificationChannel.ACTIVITY -> Color(0x61, 0xAF, 0xEF)
      NotificationChannel.TERMINAL -> Color(0x98, 0xC3, 0x79)
      NotificationChannel.INPUT_REQUIRED -> Color(0xE5, 0xC0, 0x7B)
      NotificationChannel.HOST_STATE -> Color(0xE0, 0x6C, 0x75)
    }

  private companion object {
    const val OUTPUT_ENV: String = "PI_DROID_NOTIFICATION_SCREENSHOT_DIR"
    const val WIDTH: Int = 430
    const val HEIGHT: Int = 932
  }
}
