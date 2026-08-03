package com.harryaskham.pidroid.workspace

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

public const val CURRENT_WORKSPACE_SCHEMA_VERSION: Int = 2

@Serializable
public enum class SplitAxis {
  HORIZONTAL,
  VERTICAL,
}

public enum class SplitPlacement {
  BEFORE,
  AFTER,
}

@Serializable
public enum class TargetKind {
  EMPTY,
  HOSTS,
  DIAGNOSTICS,
  SESSION_RICH,
  SESSION_TUI,
  SESSION_INFO,
}

@Serializable
public data class WorkspaceTarget(
  public val kind: TargetKind,
  public val hostId: String? = null,
  public val sessionId: String? = null,
  public val presentationState: String? = null,
)

@Serializable
public data class WorkspaceTab(
  public val id: String,
  public val title: String,
  public val target: WorkspaceTarget,
  public val pinned: Boolean = false,
)

@Serializable
public sealed interface WorkspaceNode {
  public val id: String
}

@Serializable
@SerialName("split")
public data class SplitNode(
  override val id: String,
  public val axis: SplitAxis,
  public val ratio: Float,
  public val first: WorkspaceNode,
  public val second: WorkspaceNode,
) : WorkspaceNode

@Serializable
@SerialName("tabStack")
public data class TabStackNode(
  override val id: String,
  public val activeTabId: String,
  public val tabs: List<WorkspaceTab>,
) : WorkspaceNode

@Serializable
public data class WorkspaceDocument(
  public val schemaVersion: Int = CURRENT_WORKSPACE_SCHEMA_VERSION,
  public val revision: Long = 0,
  public val root: WorkspaceNode,
  public val focusedTabId: String,
)

public object WorkspaceRatios {
  public const val MIN: Float = 0.2f
  public const val MAX: Float = 0.8f

  public fun clamp(ratio: Float): Float =
    when {
      !ratio.isFinite() -> 0.5f
      ratio < MIN -> MIN
      ratio > MAX -> MAX
      else -> ratio
    }
}

public object WorkspaceLimits {
  public const val MAX_DEPTH: Int = 32
  public const val MAX_NODES: Int = 127
  public const val MAX_TABS: Int = 64
  public const val MAX_ID_LENGTH: Int = 128
  public const val MAX_TITLE_LENGTH: Int = 160
}

public object WorkspaceDefaults {
  public const val ROOT_STACK_ID: String = "safe-root-stack"
  public const val EMPTY_TAB_ID: String = "safe-empty-tab"

  public fun document(revision: Long = 0): WorkspaceDocument =
    WorkspaceDocument(
      revision = revision.coerceAtLeast(0),
      root =
        TabStackNode(
          id = ROOT_STACK_ID,
          activeTabId = EMPTY_TAB_ID,
          tabs =
            listOf(
              WorkspaceTab(
                id = EMPTY_TAB_ID,
                title = "New pane",
                target = WorkspaceTarget(TargetKind.EMPTY),
              ),
            ),
        ),
      focusedTabId = EMPTY_TAB_ID,
    )
}

public object WorkspaceModel {
  public fun normalize(document: WorkspaceDocument): WorkspaceDocument {
    val normalizedRoot = normalizeNode(document.root) ?: WorkspaceDefaults.document().root
    val tabIds = collectTabs(normalizedRoot).mapTo(linkedSetOf()) { it.id }
    val normalizedFocus = document.focusedTabId.takeIf(tabIds::contains) ?: tabIds.first()
    val candidate =
      document.copy(
        schemaVersion = CURRENT_WORKSPACE_SCHEMA_VERSION,
        root = normalizedRoot,
        focusedTabId = normalizedFocus,
      )
    return if (candidate == document) document else candidate.copy(revision = nextRevision(document.revision))
  }

  public fun addTab(
    document: WorkspaceDocument,
    stackId: String,
    tab: WorkspaceTab,
    index: Int = Int.MAX_VALUE,
  ): WorkspaceDocument {
    if (containsTab(document.root, tab.id) || collectTabs(document.root).size >= WorkspaceLimits.MAX_TABS) {
      return document
    }
    val stack = findStack(document.root, stackId) ?: return document
    val insertion = index.coerceIn(0, stack.tabs.size)
    val updatedRoot =
      mapNode(document.root) { node ->
        if (node is TabStackNode && node.id == stackId) {
          val tabs = node.tabs.toMutableList().also { it.add(insertion, tab) }
          node.copy(activeTabId = tab.id, tabs = tabs)
        } else {
          node
        }
      }
    return finishMutation(document, updatedRoot, tab.id)
  }

  public fun split(
    document: WorkspaceDocument,
    tabId: String,
    splitId: String,
    newStackId: String,
    newTab: WorkspaceTab,
    axis: SplitAxis,
    placement: SplitPlacement,
    ratio: Float = 0.5f,
  ): WorkspaceDocument {
    val source = findStackContainingTab(document.root, tabId) ?: return document
    if (
      containsNode(document.root, splitId) ||
      containsNode(document.root, newStackId) ||
      containsTab(document.root, newTab.id) ||
      collectTabs(document.root).size >= WorkspaceLimits.MAX_TABS
    ) {
      return document
    }
    val newStack = TabStackNode(id = newStackId, activeTabId = newTab.id, tabs = listOf(newTab))
    val split =
      when (placement) {
        SplitPlacement.BEFORE -> {
          SplitNode(
            id = splitId,
            axis = axis,
            ratio = WorkspaceRatios.clamp(ratio),
            first = newStack,
            second = source,
          )
        }

        SplitPlacement.AFTER -> {
          SplitNode(
            id = splitId,
            axis = axis,
            ratio = WorkspaceRatios.clamp(ratio),
            first = source,
            second = newStack,
          )
        }
      }
    val updatedRoot = replaceNode(document.root, source.id, split)
    return finishMutation(document, updatedRoot, newTab.id)
  }

  public fun moveTab(
    document: WorkspaceDocument,
    tabId: String,
    destinationStackId: String,
    index: Int,
  ): WorkspaceDocument {
    val source = findStackContainingTab(document.root, tabId) ?: return document
    val destination = findStack(document.root, destinationStackId) ?: return document
    val tab = source.tabs.first { it.id == tabId }

    if (source.id == destination.id) {
      val oldIndex = source.tabs.indexOfFirst { it.id == tabId }
      val without = source.tabs.toMutableList().also { it.removeAt(oldIndex) }
      val insertion = index.coerceIn(0, without.size)
      without.add(insertion, tab)
      if (without == source.tabs && source.activeTabId == tabId && document.focusedTabId == tabId) {
        return document
      }
      val updated = replaceNode(document.root, source.id, source.copy(activeTabId = tabId, tabs = without))
      return finishMutation(document, updated, tabId)
    }

    val removedRoot =
      replaceNode(
        document.root,
        source.id,
        source.copy(
          activeTabId = neighborAfterRemoval(source, tabId),
          tabs = source.tabs.filterNot { it.id == tabId },
        ),
      )
    val updatedDestination = findStack(removedRoot, destinationStackId) ?: return document
    val destinationTabs = updatedDestination.tabs.toMutableList()
    destinationTabs.add(index.coerceIn(0, destinationTabs.size), tab)
    val updatedRoot =
      replaceNode(
        removedRoot,
        destinationStackId,
        updatedDestination.copy(activeTabId = tabId, tabs = destinationTabs),
      )
    return finishMutation(document, updatedRoot, tabId)
  }

  public fun closeTab(
    document: WorkspaceDocument,
    tabId: String,
  ): WorkspaceDocument {
    val source = findStackContainingTab(document.root, tabId) ?: return document
    val remaining = source.tabs.filterNot { it.id == tabId }
    val replacement =
      source.copy(
        activeTabId = if (remaining.isEmpty()) "" else neighborAfterRemoval(source, tabId),
        tabs = remaining,
      )
    val updatedRoot = replaceNode(document.root, source.id, replacement)
    val requestedFocus =
      if (document.focusedTabId == tabId || source.activeTabId == tabId) {
        replacement.activeTabId
      } else {
        document.focusedTabId
      }
    return finishMutation(document, updatedRoot, requestedFocus)
  }

  public fun resizeSplit(
    document: WorkspaceDocument,
    splitId: String,
    ratio: Float,
  ): WorkspaceDocument {
    val split = findSplit(document.root, splitId) ?: return document
    val clamped = WorkspaceRatios.clamp(ratio)
    if (split.ratio == clamped) {
      return document
    }
    return finishMutation(document, replaceNode(document.root, splitId, split.copy(ratio = clamped)), document.focusedTabId)
  }

  public fun focusTab(
    document: WorkspaceDocument,
    tabId: String,
  ): WorkspaceDocument {
    val stack = findStackContainingTab(document.root, tabId) ?: return document
    if (document.focusedTabId == tabId && stack.activeTabId == tabId) {
      return document
    }
    val updatedRoot = replaceNode(document.root, stack.id, stack.copy(activeTabId = tabId))
    return finishMutation(document, updatedRoot, tabId)
  }

  public fun duplicateTab(
    document: WorkspaceDocument,
    tabId: String,
    duplicate: WorkspaceTab,
  ): WorkspaceDocument {
    val stack = findStackContainingTab(document.root, tabId) ?: return document
    val index = stack.tabs.indexOfFirst { it.id == tabId }
    return addTab(document, stack.id, duplicate, index + 1)
  }

  public fun setPinned(
    document: WorkspaceDocument,
    tabId: String,
    pinned: Boolean,
  ): WorkspaceDocument {
    val stack = findStackContainingTab(document.root, tabId) ?: return document
    val tab = stack.tabs.first { it.id == tabId }
    if (tab.pinned == pinned) {
      return document
    }
    val updatedTabs = stack.tabs.map { if (it.id == tabId) it.copy(pinned = pinned) else it }
    return finishMutation(
      document,
      replaceNode(document.root, stack.id, stack.copy(tabs = updatedTabs)),
      document.focusedTabId,
    )
  }

  public fun invariantViolations(document: WorkspaceDocument): List<String> {
    val violations = mutableListOf<String>()
    if (document.schemaVersion != CURRENT_WORKSPACE_SCHEMA_VERSION) {
      violations += "unsupported schema version ${document.schemaVersion}"
    }
    if (document.revision < 0) {
      violations += "revision must be non-negative"
    }

    val nodeIds = mutableSetOf<String>()
    val tabIds = mutableSetOf<String>()
    var nodeCount = 0
    var tabCount = 0

    fun visit(
      node: WorkspaceNode,
      depth: Int,
    ) {
      nodeCount += 1
      if (depth > WorkspaceLimits.MAX_DEPTH) {
        violations += "workspace depth exceeds ${WorkspaceLimits.MAX_DEPTH}"
      }
      if (!validId(node.id)) {
        violations += "invalid node id '${node.id}'"
      } else if (!nodeIds.add(node.id)) {
        violations += "duplicate node id '${node.id}'"
      }

      when (node) {
        is SplitNode -> {
          if (!node.ratio.isFinite() || node.ratio !in WorkspaceRatios.MIN..WorkspaceRatios.MAX) {
            violations += "split '${node.id}' ratio ${node.ratio} is outside ${WorkspaceRatios.MIN}..${WorkspaceRatios.MAX}"
          }
          visit(node.first, depth + 1)
          visit(node.second, depth + 1)
        }

        is TabStackNode -> {
          if (node.tabs.isEmpty()) {
            violations += "tab stack '${node.id}' is empty"
          }
          if (node.tabs.none { it.id == node.activeTabId }) {
            violations += "tab stack '${node.id}' has missing active tab '${node.activeTabId}'"
          }
          node.tabs.forEach { tab ->
            tabCount += 1
            if (!validId(tab.id)) {
              violations += "invalid tab id '${tab.id}'"
            } else if (!tabIds.add(tab.id)) {
              violations += "duplicate tab id '${tab.id}'"
            }
            if (tab.title.isBlank() || tab.title.length > WorkspaceLimits.MAX_TITLE_LENGTH) {
              violations += "tab '${tab.id}' has invalid title"
            }
            val sessionTarget = tab.target.kind in SESSION_TARGET_KINDS
            if (sessionTarget && (tab.target.hostId.isNullOrBlank() || tab.target.sessionId.isNullOrBlank())) {
              violations += "tab '${tab.id}' session target is missing host or session identity"
            }
          }
        }
      }
    }

    visit(document.root, 1)
    if (nodeCount > WorkspaceLimits.MAX_NODES) {
      violations += "workspace node count $nodeCount exceeds ${WorkspaceLimits.MAX_NODES}"
    }
    if (tabCount > WorkspaceLimits.MAX_TABS) {
      violations += "workspace tab count $tabCount exceeds ${WorkspaceLimits.MAX_TABS}"
    }
    if (document.focusedTabId !in tabIds) {
      violations += "focused tab '${document.focusedTabId}' does not exist"
    }
    return violations
  }

  private fun finishMutation(
    document: WorkspaceDocument,
    root: WorkspaceNode,
    requestedFocus: String,
  ): WorkspaceDocument {
    val normalizedRoot = normalizeNode(root) ?: WorkspaceDefaults.document().root
    val tabs = collectTabs(normalizedRoot)
    val focused = requestedFocus.takeIf { focus -> tabs.any { it.id == focus } } ?: tabs.first().id
    val candidate =
      document.copy(
        schemaVersion = CURRENT_WORKSPACE_SCHEMA_VERSION,
        revision = nextRevision(document.revision),
        root = normalizedRoot,
        focusedTabId = focused,
      )
    return if (invariantViolations(candidate).isEmpty()) candidate else document
  }

  private fun normalizeNode(node: WorkspaceNode): WorkspaceNode? =
    when (node) {
      is TabStackNode -> {
        if (node.tabs.isEmpty()) {
          null
        } else {
          val active = node.activeTabId.takeIf { activeId -> node.tabs.any { it.id == activeId } } ?: node.tabs.first().id
          node.copy(activeTabId = active)
        }
      }

      is SplitNode -> {
        val first = normalizeNode(node.first)
        val second = normalizeNode(node.second)
        when {
          first == null -> second
          second == null -> first
          else -> node.copy(ratio = WorkspaceRatios.clamp(node.ratio), first = first, second = second)
        }
      }
    }

  private fun neighborAfterRemoval(
    stack: TabStackNode,
    tabId: String,
  ): String {
    val index = stack.tabs.indexOfFirst { it.id == tabId }
    val remaining = stack.tabs.filterNot { it.id == tabId }
    return remaining.getOrNull(index)?.id ?: remaining.lastOrNull()?.id.orEmpty()
  }

  private fun mapNode(
    node: WorkspaceNode,
    transform: (WorkspaceNode) -> WorkspaceNode,
  ): WorkspaceNode {
    val mapped =
      when (node) {
        is TabStackNode -> node
        is SplitNode -> node.copy(first = mapNode(node.first, transform), second = mapNode(node.second, transform))
      }
    return transform(mapped)
  }

  private fun replaceNode(
    node: WorkspaceNode,
    nodeId: String,
    replacement: WorkspaceNode,
  ): WorkspaceNode = mapNode(node) { current -> if (current.id == nodeId) replacement else current }

  private fun findStack(
    node: WorkspaceNode,
    stackId: String,
  ): TabStackNode? =
    when (node) {
      is TabStackNode -> node.takeIf { it.id == stackId }
      is SplitNode -> findStack(node.first, stackId) ?: findStack(node.second, stackId)
    }

  private fun findStackContainingTab(
    node: WorkspaceNode,
    tabId: String,
  ): TabStackNode? =
    when (node) {
      is TabStackNode -> node.takeIf { stack -> stack.tabs.any { it.id == tabId } }
      is SplitNode -> findStackContainingTab(node.first, tabId) ?: findStackContainingTab(node.second, tabId)
    }

  private fun findSplit(
    node: WorkspaceNode,
    splitId: String,
  ): SplitNode? =
    when (node) {
      is TabStackNode -> null
      is SplitNode -> node.takeIf { it.id == splitId } ?: findSplit(node.first, splitId) ?: findSplit(node.second, splitId)
    }

  private fun containsNode(
    node: WorkspaceNode,
    nodeId: String,
  ): Boolean =
    when (node) {
      is TabStackNode -> node.id == nodeId
      is SplitNode -> node.id == nodeId || containsNode(node.first, nodeId) || containsNode(node.second, nodeId)
    }

  private fun containsTab(
    node: WorkspaceNode,
    tabId: String,
  ): Boolean = collectTabs(node).any { it.id == tabId }

  private fun collectTabs(node: WorkspaceNode): List<WorkspaceTab> =
    when (node) {
      is TabStackNode -> node.tabs
      is SplitNode -> collectTabs(node.first) + collectTabs(node.second)
    }

  private fun validId(id: String): Boolean = id.isNotBlank() && id.length <= WorkspaceLimits.MAX_ID_LENGTH

  private fun nextRevision(revision: Long): Long = if (revision == Long.MAX_VALUE) Long.MAX_VALUE else revision + 1

  private val SESSION_TARGET_KINDS: Set<TargetKind> =
    setOf(TargetKind.SESSION_RICH, TargetKind.SESSION_TUI, TargetKind.SESSION_INFO)
}
