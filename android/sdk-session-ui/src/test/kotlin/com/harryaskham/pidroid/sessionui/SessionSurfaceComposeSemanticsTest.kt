package com.harryaskham.pidroid.sessionui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SessionSurfaceComposeSemanticsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun `phone surface exposes readonly session host freshness and stable transcript semantics`() {
    val state = SessionSurfaceTestFixtures.state(CacheFreshness.RECONNECTING, 2_000)
    composeRule.setContent {
      SessionSurface(
        state = state,
        layout = SessionSurfaceLayout.phone(fontScale = 1f),
      )
    }

    composeRule.onNodeWithContentDescription("Readonly session Contract fixture on Workstation").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Host Workstation, Reconnecting · 2s").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Transcript user entry:entry-user-01").assertExists()
    composeRule.onNodeWithContentDescription("Readonly surface; commands unavailable").assertExists()
    composeRule.onNodeWithText("Send").assertDoesNotExist()
    composeRule.onNodeWithText("Acquire control").assertDoesNotExist()
  }

  @Test
  fun `tablet surface shows inventory information and offline cache without command chrome`() {
    val state = SessionSurfaceTestFixtures.state(CacheFreshness.OFFLINE_CACHED, 65_000)
    composeRule.setContent {
      SessionSurface(
        state = state,
        layout = SessionSurfaceLayout.tablet(fontScale = 1f),
      )
    }

    composeRule.onNodeWithContentDescription("Session inventory, 1 item").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Session information Contract fixture").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Host Workstation, Offline cached · 1m").assertIsDisplayed()
    composeRule.onNodeWithText("fixture-model").assertIsDisplayed()
    composeRule.onNodeWithText("Wake").assertDoesNotExist()
  }

  @Test
  fun `adaptive density retains accessible touch and text bounds`() {
    val phone = SessionSurfaceLayout.phone(fontScale = 1.35f)
    val tablet = SessionSurfaceLayout.tablet(fontScale = 1f)

    assertTrue(phone.minimumTouchTargetDp >= 48f)
    assertTrue(phone.minimumRecordHeightDp >= 56f)
    assertTrue(phone.fontScale >= 1.35f)
    assertEquals(SessionSurfaceFormFactor.PHONE, phone.formFactor)
    assertEquals(SessionSurfaceFormFactor.TABLET, tablet.formFactor)
    assertTrue(tablet.inventoryWidthDp >= 260f)
  }
}
