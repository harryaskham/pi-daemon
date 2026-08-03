package com.harryaskham.pidroid.workspace

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class WorkspaceModelTest {
  @Test
  fun `normalize clamps ratios collapses empty branches and repairs focus`() {
    val document =
      WorkspaceDocument(
        revision = 7,
        focusedTabId = "missing",
        root =
          SplitNode(
            id = "outer",
            axis = SplitAxis.HORIZONTAL,
            ratio = 1.4f,
            first =
              TabStackNode(
                id = "empty-stack",
                activeTabId = "missing",
                tabs = emptyList(),
              ),
            second =
              SplitNode(
                id = "inner",
                axis = SplitAxis.VERTICAL,
                ratio = -0.2f,
                first = stack("primary", tab("one"), activeTabId = "missing"),
                second = stack("secondary", tab("two")),
              ),
          ),
      )

    val normalized = WorkspaceModel.normalize(document)
    val root = assertInstanceOf(SplitNode::class.java, normalized.root)

    assertEquals("inner", root.id)
    assertEquals(WorkspaceRatios.MIN, root.ratio)
    assertEquals("one", (root.first as TabStackNode).activeTabId)
    assertEquals("one", normalized.focusedTabId)
    assertEquals(8, normalized.revision)
    assertTrue(WorkspaceModel.invariantViolations(normalized).isEmpty())
  }

  @Test
  fun `split supports tabs inside recursively nested splits`() {
    val initial = document(stack("root-stack", tab("one"), tab("two")))

    val firstSplit =
      WorkspaceModel.split(
        document = initial,
        tabId = "one",
        splitId = "split-a",
        newStackId = "stack-a",
        newTab = tab("three"),
        axis = SplitAxis.HORIZONTAL,
        placement = SplitPlacement.AFTER,
        ratio = 0.62f,
      )
    val nested =
      WorkspaceModel.split(
        document = firstSplit,
        tabId = "three",
        splitId = "split-b",
        newStackId = "stack-b",
        newTab = tab("four"),
        axis = SplitAxis.VERTICAL,
        placement = SplitPlacement.BEFORE,
        ratio = 0.4f,
      )

    val outer = assertInstanceOf(SplitNode::class.java, nested.root)
    val inner = assertInstanceOf(SplitNode::class.java, outer.second)
    assertEquals(SplitAxis.HORIZONTAL, outer.axis)
    assertEquals(SplitAxis.VERTICAL, inner.axis)
    assertEquals("four", ((inner.first as TabStackNode).tabs.single()).id)
    assertEquals(listOf("one", "two"), (outer.first as TabStackNode).tabs.map { it.id })
    assertEquals("four", nested.focusedTabId)
    assertTrue(WorkspaceModel.invariantViolations(nested).isEmpty())
  }

  @Test
  fun `move tab across nested stacks preserves order and collapses empty source`() {
    val initial =
      document(
        SplitNode(
          id = "split",
          axis = SplitAxis.HORIZONTAL,
          ratio = 0.5f,
          first = stack("left", tab("one")),
          second = stack("right", tab("two"), tab("three")),
        ),
      )

    val moved = WorkspaceModel.moveTab(initial, tabId = "one", destinationStackId = "right", index = 1)
    val root = assertInstanceOf(TabStackNode::class.java, moved.root)

    assertEquals("right", root.id)
    assertEquals(listOf("two", "one", "three"), root.tabs.map { it.id })
    assertEquals("one", root.activeTabId)
    assertEquals("one", moved.focusedTabId)
    assertEquals(initial.revision + 1, moved.revision)
    assertTrue(WorkspaceModel.invariantViolations(moved).isEmpty())
  }

  @Test
  fun `moving within one stack is stable and unknown destinations are no ops`() {
    val initial = document(stack("only", tab("one"), tab("two"), tab("three")))

    val reordered = WorkspaceModel.moveTab(initial, tabId = "three", destinationStackId = "only", index = 0)
    val tabs = (reordered.root as TabStackNode).tabs.map { it.id }
    assertEquals(listOf("three", "one", "two"), tabs)
    assertEquals("three", reordered.focusedTabId)

    assertEquals(reordered, WorkspaceModel.moveTab(reordered, "three", "missing", 1))
    assertEquals(reordered, WorkspaceModel.moveTab(reordered, "missing", "only", 1))
  }

  @Test
  fun `close selects a neighbor collapses splits and falls back after the last tab`() {
    val initial =
      document(
        SplitNode(
          id = "split",
          axis = SplitAxis.VERTICAL,
          ratio = 0.5f,
          first = stack("top", tab("one"), tab("two"), activeTabId = "two"),
          second = stack("bottom", tab("three")),
        ),
        focusedTabId = "two",
      )

    val neighborSelected = WorkspaceModel.closeTab(initial, "two")
    assertEquals("one", (findStack(neighborSelected.root, "top") ?: error("top stack missing")).activeTabId)
    assertEquals("one", neighborSelected.focusedTabId)

    val splitCollapsed = WorkspaceModel.closeTab(neighborSelected, "one")
    val remaining = assertInstanceOf(TabStackNode::class.java, splitCollapsed.root)
    assertEquals("bottom", remaining.id)
    assertEquals("three", splitCollapsed.focusedTabId)

    val fallback = WorkspaceModel.closeTab(splitCollapsed, "three")
    val fallbackStack = assertInstanceOf(TabStackNode::class.java, fallback.root)
    assertEquals(WorkspaceDefaults.EMPTY_TAB_ID, fallbackStack.tabs.single().id)
    assertEquals(WorkspaceDefaults.EMPTY_TAB_ID, fallback.focusedTabId)
    assertTrue(WorkspaceModel.invariantViolations(fallback).isEmpty())
  }

  @Test
  fun `resize clamps ratios and changes only the addressed split`() {
    val initial =
      document(
        SplitNode(
          id = "outer",
          axis = SplitAxis.HORIZONTAL,
          ratio = 0.5f,
          first = stack("left", tab("one")),
          second =
            SplitNode(
              id = "inner",
              axis = SplitAxis.VERTICAL,
              ratio = 0.5f,
              first = stack("top", tab("two")),
              second = stack("bottom", tab("three")),
            ),
        ),
      )

    val resized = WorkspaceModel.resizeSplit(initial, "inner", 0.99f)
    val outer = resized.root as SplitNode
    val inner = outer.second as SplitNode
    assertEquals(0.5f, outer.ratio)
    assertEquals(WorkspaceRatios.MAX, inner.ratio)
    assertEquals(initial.revision + 1, resized.revision)
    assertEquals(resized, WorkspaceModel.resizeSplit(resized, "missing", 0.4f))
  }

  @Test
  fun `codec round trips current state and migrates version one`() {
    val current =
      WorkspaceDocument(
        revision = 42,
        focusedTabId = "chat",
        root = stack("primary", tab("chat", TargetKind.SESSION_RICH)),
      )
    val encoded = WorkspacePersistence.encode(current)
    val restored = assertInstanceOf(WorkspaceRestoreResult.Loaded::class.java, WorkspacePersistence.restore(encoded))
    assertEquals(current, restored.document)
    assertEquals(null, restored.migratedFrom)

    val versionOne =
      """
      {
        "schemaVersion": 1,
        "revision": 9,
        "selectedTabId": "chat",
        "futureTopLevel": { "ignored": true },
        "root": {
          "type": "tabStack",
          "id": "primary",
          "activeTabId": "chat",
          "tabs": [{
            "id": "chat",
            "title": "Build room",
            "target": {
              "kind": "SESSION",
              "hostId": "host-a",
              "sessionId": "session-a",
              "futureTargetField": 7
            }
          }]
        }
      }
      """.trimIndent()
    val migrated = assertInstanceOf(WorkspaceRestoreResult.Loaded::class.java, WorkspacePersistence.restore(versionOne))
    assertEquals(1, migrated.migratedFrom)
    assertEquals(CURRENT_WORKSPACE_SCHEMA_VERSION, migrated.document.schemaVersion)
    assertEquals("chat", migrated.document.focusedTabId)
    assertEquals(
      TargetKind.SESSION_RICH,
      (migrated.document.root as TabStackNode)
        .tabs
        .single()
        .target.kind,
    )
    assertTrue(WorkspaceModel.invariantViolations(migrated.document).isEmpty())
  }

  @Test
  fun `corrupt and future workspace payloads quarantine to a safe default`() {
    val duplicateIds =
      WorkspaceDocument(
        root =
          SplitNode(
            id = "split",
            axis = SplitAxis.HORIZONTAL,
            ratio = 0.5f,
            first = stack("left", tab("duplicate")),
            second = stack("right", tab("duplicate")),
          ),
        focusedTabId = "duplicate",
      )
    val corrupt =
      assertInstanceOf(
        WorkspaceRestoreResult.Quarantined::class.java,
        WorkspacePersistence.restore(WorkspacePersistence.encode(duplicateIds)),
      )
    assertTrue(corrupt.reason.contains("duplicate"))
    assertTrue(WorkspaceModel.invariantViolations(corrupt.fallback).isEmpty())

    val future =
      assertInstanceOf(
        WorkspaceRestoreResult.Quarantined::class.java,
        WorkspacePersistence.restore("""{"schemaVersion":999,"revision":0,"root":{}}"""),
      )
    assertTrue(future.reason.contains("unsupported schema version"))
  }

  @Test
  fun `deterministic random operations preserve all workspace invariants`() {
    val random = Random(0x6A0357)
    var nextId = 0
    var document = document(stack("stack-0", tab("tab-0")))

    repeat(2_000) {
      val tabs = collectTabs(document.root)
      val stacks = collectStacks(document.root)
      val splits = collectSplits(document.root)
      when (random.nextInt(6)) {
        0 -> {
          val source = tabs.random(random)
          nextId += 1
          document =
            WorkspaceModel.split(
              document = document,
              tabId = source.id,
              splitId = "split-$nextId",
              newStackId = "stack-$nextId",
              newTab = tab("tab-$nextId"),
              axis = if (random.nextBoolean()) SplitAxis.HORIZONTAL else SplitAxis.VERTICAL,
              placement = if (random.nextBoolean()) SplitPlacement.BEFORE else SplitPlacement.AFTER,
              ratio = random.nextFloat() * 1.4f - 0.2f,
            )
        }

        1 -> {
          nextId += 1
          document = WorkspaceModel.addTab(document, stacks.random(random).id, tab("tab-$nextId"))
        }

        2 -> {
          val source = tabs.random(random)
          val destination = stacks.random(random)
          document = WorkspaceModel.moveTab(document, source.id, destination.id, random.nextInt(destination.tabs.size + 2))
        }

        3 -> {
          document = WorkspaceModel.closeTab(document, tabs.random(random).id)
        }

        4 -> {
          if (splits.isNotEmpty()) {
            document = WorkspaceModel.resizeSplit(document, splits.random(random).id, random.nextFloat() * 1.6f - 0.3f)
          }
        }

        else -> {
          document = WorkspaceModel.focusTab(document, tabs.random(random).id)
        }
      }

      val violations = WorkspaceModel.invariantViolations(document)
      assertTrue(violations.isEmpty(), "operation $it violated: $violations\n$document")
      assertTrue(document.revision >= 0)

      if (it % 100 == 0) {
        val restored = WorkspacePersistence.restore(WorkspacePersistence.encode(document))
        assertInstanceOf(WorkspaceRestoreResult.Loaded::class.java, restored)
        assertEquals(document, (restored as WorkspaceRestoreResult.Loaded).document)
      }
    }

    assertNotEquals(0, document.revision)
    assertFalse(collectTabs(document.root).isEmpty())
  }

  private fun document(
    root: WorkspaceNode,
    focusedTabId: String = collectTabs(root).first().id,
  ): WorkspaceDocument = WorkspaceDocument(root = root, focusedTabId = focusedTabId)

  private fun stack(
    id: String,
    vararg tabs: WorkspaceTab,
    activeTabId: String = tabs.firstOrNull()?.id ?: "missing",
  ): TabStackNode = TabStackNode(id = id, activeTabId = activeTabId, tabs = tabs.toList())

  private fun tab(
    id: String,
    kind: TargetKind = TargetKind.EMPTY,
  ): WorkspaceTab =
    WorkspaceTab(
      id = id,
      title = id.replaceFirstChar(Char::uppercase),
      target =
        WorkspaceTarget(
          kind = kind,
          hostId = if (kind.name.startsWith("SESSION")) "host-a" else null,
          sessionId = if (kind.name.startsWith("SESSION")) "session-$id" else null,
        ),
    )

  private fun findStack(
    node: WorkspaceNode,
    id: String,
  ): TabStackNode? =
    when (node) {
      is TabStackNode -> node.takeIf { it.id == id }
      is SplitNode -> findStack(node.first, id) ?: findStack(node.second, id)
    }

  private fun collectTabs(node: WorkspaceNode): List<WorkspaceTab> = collectStacks(node).flatMap { it.tabs }

  private fun collectStacks(node: WorkspaceNode): List<TabStackNode> =
    when (node) {
      is TabStackNode -> listOf(node)
      is SplitNode -> collectStacks(node.first) + collectStacks(node.second)
    }

  private fun collectSplits(node: WorkspaceNode): List<SplitNode> =
    when (node) {
      is TabStackNode -> emptyList()
      is SplitNode -> listOf(node) + collectSplits(node.first) + collectSplits(node.second)
    }
}
