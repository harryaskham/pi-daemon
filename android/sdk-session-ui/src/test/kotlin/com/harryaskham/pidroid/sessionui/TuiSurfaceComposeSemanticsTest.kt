package com.harryaskham.pidroid.sessionui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class TuiSurfaceComposeSemanticsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun `observer phone surface labels identity cursor rows and inert input`() {
    composeRule.setContent {
      TuiSurface(
        state = TuiSurfaceTestFixtures.observerState(),
        layout = TuiSurfaceLayout.phone(fontScale = 1f),
      )
    }

    composeRule.onNodeWithContentDescription("Terminal Pi fixture, session session-fixture-01 generation 3").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Observer; terminal input and resize intents require controller authority").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Terminal row 1: Pi Droid terminal").assertExists()
    composeRule.onNodeWithContentDescription("Terminal cursor row 2 column 1, block").assertExists()
    composeRule.onNodeWithText("OBSERVER · INPUT INERT").assertIsDisplayed()
  }

  @Test
  fun `controller tablet surface is clearly labelled without dispatching transport`() {
    composeRule.setContent {
      TuiSurface(
        state = TuiSurfaceTestFixtures.controllerState(),
        layout = TuiSurfaceLayout.tablet(fontScale = 1.1f),
      )
    }

    composeRule.onNodeWithContentDescription("Controller; terminal input and resize intents ready for transport").assertIsDisplayed()
    composeRule.onNodeWithText("CONTROLLER · INTENTS READY").assertIsDisplayed()
    composeRule.onNodeWithText("Pi fixture").assertIsDisplayed()
  }

  @Test
  fun `replay gap surface clears rows and announces resynchronization`() {
    val waiting =
      TuiFrameReducer.applyReplayGap(
        TuiSurfaceTestFixtures.controllerState(),
        TuiFrameDecoder.decodeReplayGap(TuiSurfaceTestFixtures.replayGapJson()),
      )
    composeRule.setContent {
      TuiSurface(
        state = waiting,
        layout = TuiSurfaceLayout.phone(),
      )
    }

    composeRule.onNodeWithContentDescription("Terminal resynchronization required: cursor-expired").assertIsDisplayed()
    composeRule.onNodeWithText("Waiting for a fresh terminal snapshot").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Terminal row 1: Pi Droid terminal").assertDoesNotExist()
  }

  @Test
  fun `layout retains accessible and bounded terminal geometry`() {
    val phone = TuiSurfaceLayout.phone(fontScale = 1.35f)
    val tablet = TuiSurfaceLayout.tablet(fontScale = 1f)

    assertTrue(phone.minimumTouchTargetDp >= 48f)
    assertTrue(phone.minimumRowHeightDp >= 20f)
    assertEquals(TuiSurfaceFormFactor.PHONE, phone.formFactor)
    assertEquals(TuiSurfaceFormFactor.TABLET, tablet.formFactor)
    assertTrue(tablet.terminalPaddingDp > phone.terminalPaddingDp)
  }
}
