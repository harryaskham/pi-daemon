package com.harryaskham.pidroid.sessionui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class InteractiveSessionSurfaceTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun `controller surface exposes bounded composer and exact command intents`() {
    val actions = mutableListOf<RichInteractionAction>()
    val interactive =
      RichInteractiveState.controller(
        draftText = "Review the release",
        modelLabel = "fixture-model",
        thinkingLevel = "medium",
        streaming = true,
      )
    composeRule.setContent {
      RichInteractiveSessionSurface(
        session = SessionSurfaceTestFixtures.state(),
        interactive = interactive,
        layout = SessionSurfaceLayout.phone(),
        onAction = actions::add,
      )
    }

    composeRule.onNodeWithContentDescription("Interactive session Contract fixture on Workstation").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Readonly surface; commands unavailable").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Controller authority active").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Session prompt composer").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Send follow-up").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Abort active request").assertIsDisplayed()
    composeRule.onNodeWithText("fixture-model · medium").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Send follow-up").performClick()
    composeRule.onNodeWithContentDescription("Abort active request").performClick()
    assertTrue(actions[0] is RichInteractionAction.SubmitFollowUp)
    assertTrue(actions[1] is RichInteractionAction.Abort)
    assertTrue(interactive.canMutate)
    assertFalse(interactive.toString().contains("Review the release"))
  }

  @Test
  fun `observer surface offers explicit control request and no mutation controls`() {
    val actions = mutableListOf<RichInteractionAction>()
    val interactive = RichInteractiveState.observer(modelLabel = "fixture-model", thinkingLevel = "medium")
    composeRule.setContent {
      RichInteractiveSessionSurface(
        session = SessionSurfaceTestFixtures.state(),
        interactive = interactive,
        layout = SessionSurfaceLayout.tablet(),
        onAction = actions::add,
      )
    }

    composeRule.onNodeWithContentDescription("Observer authority; request control to interact").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Request session control").assertIsDisplayed()
    composeRule.onNodeWithText("Send").assertDoesNotExist()
    composeRule.onNodeWithText("Abort").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Request session control").performClick()
    assertTrue(actions.single() is RichInteractionAction.RequestControl)
    assertFalse(interactive.canMutate)
  }

  @Test
  fun `interactive state contains no bearer transport path or Cacophony fields`() {
    val forbidden = setOf("bearer", "credential", "transport", "path", "agent", "bead", "profile")
    val names =
      RichInteractiveState::class.java.declaredFields
        .map { it.name }
        .toSet() +
        RichInteractionAction::class.java.declaredClasses.map { it.simpleName.lowercase() }
    assertTrue(names.none { it in forbidden })
  }
}
