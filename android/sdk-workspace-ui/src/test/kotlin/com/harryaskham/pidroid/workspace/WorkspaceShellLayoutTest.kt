package com.harryaskham.pidroid.workspace

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class WorkspaceShellLayoutTest {
  @Test
  fun `phone projects one focused stack behind an accessible drawer`() {
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val layout = WorkspaceAdaptivePolicy.resolve(WorkspaceViewport(widthDp = 411, heightDp = 891))
    val projection = WorkspaceShellProjection.project(fixture.document, layout)

    assertEquals(WorkspaceFormFactor.PHONE, layout.formFactor)
    assertEquals(WorkspaceNavigation.DRAWER, layout.navigation)
    assertFalse(layout.sidebarInitiallyExpanded)
    assertFalse(layout.renderAllPanes)
    assertEquals(listOf("build-stack"), projection.visibleStackIds)
    assertEquals(listOf("build", "logs"), projection.visibleTabIds)
    assertEquals("build", projection.focusedTabId)
  }

  @Test
  fun `tablet keeps a collapsible sidebar and renders every nested split and tab stack`() {
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val layout = WorkspaceAdaptivePolicy.resolve(WorkspaceViewport(widthDp = 1_024, heightDp = 768))
    val projection = WorkspaceShellProjection.project(fixture.document, layout)

    assertEquals(WorkspaceFormFactor.TABLET, layout.formFactor)
    assertEquals(WorkspaceNavigation.COLLAPSIBLE_SIDEBAR, layout.navigation)
    assertTrue(layout.sidebarInitiallyExpanded)
    assertTrue(layout.renderAllPanes)
    assertEquals(listOf("outer-split", "right-split"), projection.visibleSplitIds)
    assertEquals(listOf("build-stack", "notes-stack", "diagnostics-stack"), projection.visibleStackIds)
    assertEquals(listOf("build", "logs", "notes", "diagnostics"), projection.visibleTabIds)
  }

  @Test
  fun `foldable assigns the recursive workspace to two safe regions around the hinge`() {
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val layout =
      WorkspaceAdaptivePolicy.resolve(
        WorkspaceViewport(
          widthDp = 1_344,
          heightDp = 840,
          hinge = WorkspaceHinge(offsetDp = 656, widthDp = 32),
        ),
      )
    val projection = WorkspaceShellProjection.project(fixture.document, layout)

    assertEquals(WorkspaceFormFactor.FOLDABLE, layout.formFactor)
    assertEquals(WorkspaceNavigation.COLLAPSIBLE_SIDEBAR, layout.navigation)
    assertEquals(2, layout.contentRegions.size)
    assertEquals(656f, layout.contentRegions.first().widthDp)
    assertEquals(656f, layout.contentRegions.last().widthDp)
    assertEquals(3, projection.visibleStackIds.size)
    assertTrue(layout.contentRegions.zipWithNext().all { (first, second) -> first.endDp <= second.startDp })
  }

  @Test
  fun `shell reducer focuses closes and restores through the pure workspace model`() {
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val initial = WorkspaceShellState(document = fixture.document, sidebarExpanded = true)

    val focused = WorkspaceShellReducer.reduce(initial, WorkspaceShellAction.FocusTab("notes"))
    assertEquals("notes", focused.document.focusedTabId)

    val closed = WorkspaceShellReducer.reduce(focused, WorkspaceShellAction.CloseTab("notes"))
    assertFalse(WorkspaceShellProjection.allTabIds(closed.document).contains("notes"))
    assertEquals("build", closed.document.focusedTabId)

    val restored =
      WorkspaceShellReducer.reduce(
        closed,
        WorkspaceShellAction.Restore(WorkspacePersistence.encode(fixture.document)),
      )
    assertEquals(fixture.document, restored.document)
    assertNull(restored.quarantineReason)

    val quarantined = WorkspaceShellReducer.reduce(restored, WorkspaceShellAction.Restore("not-json"))
    assertEquals(WorkspaceDefaults.EMPTY_TAB_ID, quarantined.document.focusedTabId)
    assertTrue(quarantined.quarantineReason?.contains("invalid workspace JSON") == true)
  }

  @Test
  fun `semantics expose navigation pane tab close and resize controls`() {
    val fixture = WorkspaceShellFixtures.nestedWorkspace()
    val layout = WorkspaceAdaptivePolicy.resolve(WorkspaceViewport(widthDp = 411, heightDp = 891))
    val semantics = WorkspaceShellSemantics.describe(fixture, layout)

    assertTrue("Open navigation drawer" in semantics.controlLabels)
    assertTrue("Pane Build room" in semantics.regionLabels)
    assertTrue("Tab Build room, selected" in semantics.controlLabels)
    assertTrue("Close Build room" in semantics.controlLabels)
    assertTrue("Resize horizontal split" in semantics.controlLabels)
    assertTrue(semantics.controlLabels.none(String::isBlank))
  }

  @Test
  fun `large text keeps touch targets scrollable tabs and non-compact navigation`() {
    val layout =
      WorkspaceAdaptivePolicy.resolve(
        WorkspaceViewport(
          widthDp = 720,
          heightDp = 960,
          fontScale = 2f,
        ),
      )

    assertEquals(WorkspaceFormFactor.TABLET, layout.formFactor)
    assertEquals(WorkspaceNavigation.COLLAPSIBLE_SIDEBAR, layout.navigation)
    assertTrue(layout.tabRowScrollable)
    assertFalse(layout.compactChrome)
    assertTrue(layout.minimumTouchTargetDp >= 48f)
    assertTrue(layout.minimumTabHeightDp >= 56f)
    assertTrue(layout.sidebarWidthDp >= 280f)
  }
}
