package com.harryaskham.pidroid.workspace

import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class DailyDriverUxComposeSemanticsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun `phone fixture exposes inventory destinations role and minimum touch targets`() {
    composeRule.setContent {
      PiDroidDailyDriverShowcase(PiDroidDailyDriverScreenshotFixtures.profile("phone"))
    }

    composeRule
      .onNodeWithContentDescription(
        "Open host management",
      ).assertIsDisplayed()
      .assertHeightIsAtLeast(48.dp)
      .assertWidthIsAtLeast(48.dp)
    composeRule.onNodeWithContentDescription("Search session inventory").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
    composeRule.onNodeWithContentDescription("All sessions filter, selected").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
    composeRule.onNodeWithContentDescription("Transcript destination, selected").assertExists().assertHeightIsAtLeast(48.dp)
    composeRule.onNodeWithContentDescription("Extensions destination").assertExists().assertHeightIsAtLeast(48.dp)
    composeRule.onNodeWithContentDescription("Status: Controller").assertExists()
    composeRule
      .onNodeWithContentDescription("Send prompt")
      .assertExists()
      .assertHeightIsAtLeast(48.dp)
      .assertWidthIsAtLeast(48.dp)
  }

  @Test
  fun `tablet fixture exposes stable adaptive session chrome`() {
    composeRule.setContent {
      PiDroidDailyDriverShowcase(PiDroidDailyDriverScreenshotFixtures.profile("tablet"))
    }
    composeRule.onNodeWithContentDescription("Pi Droid daily driver, tablet layout").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Session Daily driver polish, pi-daemon · just now, selected, unread").assertIsDisplayed()
  }

  @Test
  fun `wide fixture exposes bounded safety context`() {
    composeRule.setContent {
      PiDroidDailyDriverShowcase(PiDroidDailyDriverScreenshotFixtures.profile("wide"))
    }
    composeRule.onNodeWithContentDescription("Pi Droid daily driver, wide layout").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Status: No secrets retained").assertIsDisplayed()
  }

  @Test
  fun `remote cleartext card exposes a named full-height acknowledgement`() {
    composeRule.setContent {
      PiDroidUxTheme {
        PiDroidEndpointSecurityCard(
          assessment = PiDroidEndpointPolicy.assess("http://192.168.20.5:9321"),
          acknowledged = false,
          onAcknowledgedChange = {},
        )
      }
    }

    composeRule
      .onNodeWithContentDescription("Acknowledge remote cleartext risk")
      .assertIsDisplayed()
      .assertHeightIsAtLeast(48.dp)
  }

  @Test
  fun `large text fixture collapses safely and profile matrix is exact`() {
    composeRule.setContent {
      PiDroidDailyDriverShowcase(PiDroidDailyDriverScreenshotFixtures.profile("accessibility"))
    }

    composeRule.onNodeWithContentDescription("Pi Droid daily driver, phone layout").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Open host management").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
    assertEquals(
      listOf("phone", "tablet", "wide", "accessibility"),
      PiDroidDailyDriverScreenshotFixtures.all.map { it.id },
    )
  }
}
