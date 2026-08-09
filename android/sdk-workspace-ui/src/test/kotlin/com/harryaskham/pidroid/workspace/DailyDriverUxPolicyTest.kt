package com.harryaskham.pidroid.workspace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DailyDriverUxPolicyTest {
  @Test
  fun `adaptive policy covers phone tablet wide and large text without shrinking targets`() {
    val phone = PiDroidDailyDriverAdaptivePolicy.resolve(411)
    val tablet = PiDroidDailyDriverAdaptivePolicy.resolve(840)
    val wide = PiDroidDailyDriverAdaptivePolicy.resolve(1_280)
    val largeText = PiDroidDailyDriverAdaptivePolicy.resolve(widthDp = 720, fontScale = 2f)

    assertEquals(PiDroidWindowClass.PHONE, phone.windowClass)
    assertEquals(PiDroidWindowClass.TABLET, tablet.windowClass)
    assertEquals(PiDroidWindowClass.WIDE, wide.windowClass)
    assertEquals(PiDroidWindowClass.PHONE, largeText.windowClass)
    assertTrue(listOf(phone, tablet, wide, largeText).all { it.minimumTouchTargetDp >= 48f })
    assertFalse(phone.showPersistentSessionRail)
    assertTrue(tablet.showPersistentSessionRail)
    assertTrue(wide.showContextPane)
  }

  @Test
  fun `endpoint policy requires an explicit acknowledgement only for remote cleartext`() {
    val secure = PiDroidEndpointPolicy.assess("https://pi.example.test:9443")
    val loopback = PiDroidEndpointPolicy.assess("http://127.0.0.1:9321")
    val remoteHttp = PiDroidEndpointPolicy.assess("http://192.168.20.5:9321")
    val embeddedCredential = PiDroidEndpointPolicy.assess("https://bearer@pi.example.test")
    val unsupported = PiDroidEndpointPolicy.assess("ssh://pi.example.test")

    assertEquals(PiDroidEndpointSecurity.SECURE, secure.security)
    assertEquals(PiDroidEndpointSecurity.LOOPBACK_HTTP, loopback.security)
    assertEquals(PiDroidEndpointSecurity.REMOTE_HTTP_REQUIRES_ACKNOWLEDGEMENT, remoteHttp.security)
    assertTrue(remoteHttp.requiresCleartextAcknowledgement)
    assertTrue(remoteHttp.canConnect)
    assertFalse(secure.requiresCleartextAcknowledgement)
    assertFalse(loopback.requiresCleartextAcknowledgement)
    assertFalse(embeddedCredential.canConnect)
    assertFalse(unsupported.canConnect)
  }

  @Test
  fun `session inventory searches filters and sorts by recency deterministically`() {
    val sessions =
      listOf(
        PiDroidSessionSummary(
          id = "older",
          title = "Release notes",
          project = "docs",
          cwd = "/work/docs",
          state = "idle",
          unread = false,
          activityAt = "2026-04-01T09:00:00Z",
        ),
        PiDroidSessionSummary(
          id = "active",
          title = "Daily driver polish",
          project = "pi-daemon",
          cwd = "/work/pi-daemon",
          state = "running",
          unread = true,
          activityAt = "2026-04-01T10:00:00Z",
        ),
        PiDroidSessionSummary(
          id = "newest",
          title = "SDK migration",
          project = "android",
          cwd = "/work/android",
          state = "connected",
          unread = false,
          activityAt = "2026-04-01T11:00:00Z",
        ),
      )

    assertEquals(
      listOf("newest", "active", "older"),
      PiDroidSessionInventory.filter(sessions, query = "", filter = PiDroidSessionFilter.ALL).map { it.id },
    )
    assertEquals(
      listOf("active"),
      PiDroidSessionInventory.filter(sessions, query = "daemon", filter = PiDroidSessionFilter.ACTIVE).map { it.id },
    )
    assertEquals(
      listOf("active"),
      PiDroidSessionInventory.filter(sessions, query = "", filter = PiDroidSessionFilter.UNREAD).map { it.id },
    )
  }

  @Test
  fun `relative activity labels have exact stable boundaries`() {
    val now = Instant.parse("2026-04-08T12:00:00Z")

    assertEquals("Activity unknown", PiDroidRelativeActivity.label(null, now))
    assertEquals("Just now", PiDroidRelativeActivity.label("2026-04-08T11:59:30Z", now))
    assertEquals("12m ago", PiDroidRelativeActivity.label("2026-04-08T11:48:00Z", now))
    assertEquals("3h ago", PiDroidRelativeActivity.label("2026-04-08T09:00:00Z", now))
    assertEquals("2d ago", PiDroidRelativeActivity.label("2026-04-06T12:00:00Z", now))
    assertEquals("Mar 30", PiDroidRelativeActivity.label("2026-03-30T12:00:00Z", now))
  }
}
