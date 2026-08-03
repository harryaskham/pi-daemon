package com.harryaskham.pidroid.sessionui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.SessionRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class InteractiveSessionComposeSemanticsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun `observer branch tree exposes bounded accessible rows with inert navigation`() {
    composeRule.setContent {
      SessionTreeSurface(
        snapshot = InteractiveSessionTestFixtures.tree(),
        context = InteractiveSessionTestFixtures.context(SessionRole.OBSERVER),
      )
    }

    composeRule.onNodeWithContentDescription("Session branch tree, 4 entries").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Branch entry User request, depth 1, inactive").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Navigate to User request").assertIsNotEnabled()
    composeRule.onNodeWithText("Observer · actions unavailable").assertIsDisplayed()
  }

  @Test
  fun `fresh controller branch action emits only the exact gated intent`() {
    val intents = mutableListOf<TreeNavigationIntent>()
    composeRule.setContent {
      SessionTreeSurface(
        snapshot = InteractiveSessionTestFixtures.tree(),
        context = InteractiveSessionTestFixtures.context(),
        onIntent = intents::add,
      )
    }

    composeRule.onNodeWithContentDescription("Navigate to User request").assertIsEnabled().performClick()
    assertEquals(1, intents.size)
    assertEquals(InteractiveSessionTestFixtures.identity, intents.single().identity)
    assertEquals("entry-user-01", intents.single().entryId)
    assertTrue(intents.single().correlationId.startsWith("tree-ui-"))
  }

  @Test
  fun `stale extension falls back accessibly and keeps every action inert`() {
    val view = InteractiveSessionTestFixtures.extensionView(CacheFreshness.STALE, unsupported = true)
    composeRule.setContent {
      DeclarativeExtensionSurface(
        view = view,
        context = InteractiveSessionTestFixtures.context(SessionRole.CONTROLLER, CacheFreshness.STALE),
      )
    }

    composeRule.onNodeWithContentDescription("Declarative extension Review bounded changes, revision 2").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Unsupported extension node future-panel; fallback available").assertIsDisplayed()
    composeRule.onNodeWithText("Review two changed files and choose whether to continue.").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Extension action Continue").assertIsNotEnabled()
    composeRule.onNodeWithText("Controller · actions unavailable · 11 bounded nodes").assertIsDisplayed()
  }

  @Test
  fun `fresh controller extension actions and complete form are enabled and correlated`() {
    val intents = mutableListOf<ExtensionActionIntent>()
    val view = InteractiveSessionTestFixtures.extensionView()
    composeRule.setContent {
      DeclarativeExtensionSurface(
        view = view,
        context = InteractiveSessionTestFixtures.context(),
        formValues = InteractiveSessionTestFixtures.completeFormValues(),
        onIntent = intents::add,
      )
    }

    composeRule.onNodeWithContentDescription("Extension action Continue").assertIsEnabled().performClick()
    composeRule.onNodeWithContentDescription("Extension action Submit review").assertIsEnabled()
    composeRule.onNodeWithContentDescription("Extension form field Summary").assertIsDisplayed()
    assertEquals(1, intents.size)
    assertEquals(view.identity, intents.single().identity)
    assertEquals(view.correlationId, intents.single().correlationId)
    assertEquals("continue", intents.single().actionId)
  }
}
