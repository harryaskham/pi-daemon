package com.harryaskham.pidroid.workspace

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class WorkspaceComposeSemanticsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun `phone shell exposes drawer pane selected tab and close semantics`() {
    val profile = WorkspaceScreenshotFixtures.profile("phone")
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    composeRule.setContent {
      PiDroidWorkspaceShell(
        fixture = fixture,
        layout = WorkspaceAdaptivePolicy.resolve(profile.viewport),
        state = WorkspaceShellState(document = fixture.document, sidebarExpanded = false),
      )
    }

    composeRule.onNodeWithContentDescription("Open navigation drawer").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Pane Build room").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Tab Build room, selected").assertExists()
    composeRule.onNodeWithContentDescription("Close Build room").assertExists()
  }

  @Test
  fun `tablet shell exposes nested pane split and collapsible sidebar semantics`() {
    val profile = WorkspaceScreenshotFixtures.profile("tablet")
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    composeRule.setContent {
      PiDroidWorkspaceShell(
        fixture = fixture,
        layout = WorkspaceAdaptivePolicy.resolve(profile.viewport),
        state = WorkspaceShellState(document = fixture.document, sidebarExpanded = true),
      )
    }

    composeRule.onNodeWithContentDescription("Collapse session sidebar").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Resize horizontal split").assertExists()
    composeRule.onNodeWithContentDescription("Pane Launch notes").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Pane Diagnostics").assertIsDisplayed()
  }

  @Test
  fun `large text shell retains named controls and screenshot fixtures are exact`() {
    val profile = WorkspaceScreenshotFixtures.profile("large-text")
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val layout = WorkspaceAdaptivePolicy.resolve(profile.viewport)
    composeRule.setContent {
      PiDroidWorkspaceShell(
        fixture = fixture,
        layout = layout,
        state = WorkspaceShellState(document = fixture.document, sidebarExpanded = false),
      )
    }

    composeRule.onNodeWithContentDescription("Expand session sidebar").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Tab Build room, selected").assertIsDisplayed()
    assertTrue(layout.minimumTouchTargetDp >= 48f)
    assertTrue(layout.minimumTabHeightDp >= 56f)

    assertEquals(listOf("phone", "tablet", "foldable", "nested", "large-text"), WorkspaceScreenshotFixtures.all.map { it.id })
    assertEquals(430, WorkspaceScreenshotFixtures.profile("phone").windowWidthPx)
    assertEquals(1_360, WorkspaceScreenshotFixtures.profile("foldable").windowWidthPx)
  }
}
