package com.harryaskham.pidroid.workspace

public data class WorkspaceHinge(
  public val offsetDp: Int,
  public val widthDp: Int,
)

public data class WorkspaceViewport(
  public val widthDp: Int,
  public val heightDp: Int,
  public val fontScale: Float = 1f,
  public val hinge: WorkspaceHinge? = null,
)

public enum class WorkspaceFormFactor {
  PHONE,
  TABLET,
  FOLDABLE,
}

public enum class WorkspaceNavigation {
  DRAWER,
  COLLAPSIBLE_SIDEBAR,
}

public data class WorkspaceContentRegion(
  public val startDp: Float,
  public val widthDp: Float,
) {
  public val endDp: Float = startDp + widthDp
}

public data class WorkspaceShellLayout(
  public val formFactor: WorkspaceFormFactor,
  public val navigation: WorkspaceNavigation,
  public val renderAllPanes: Boolean,
  public val sidebarInitiallyExpanded: Boolean,
  public val sidebarWidthDp: Float,
  public val minimumTouchTargetDp: Float,
  public val minimumTabHeightDp: Float,
  public val fontScale: Float,
  public val tabRowScrollable: Boolean,
  public val compactChrome: Boolean,
  public val contentRegions: List<WorkspaceContentRegion>,
)

public object WorkspaceAdaptivePolicy {
  public fun resolve(viewport: WorkspaceViewport): WorkspaceShellLayout {
    require(viewport.widthDp > 0 && viewport.heightDp > 0) { "viewport must be positive" }
    require(viewport.fontScale.isFinite() && viewport.fontScale > 0) { "font scale must be positive" }

    val hinge = viewport.hinge?.takeIf { it.offsetDp > 0 && it.widthDp > 0 && it.offsetDp + it.widthDp < viewport.widthDp }
    val formFactor =
      when {
        hinge != null -> WorkspaceFormFactor.FOLDABLE
        viewport.widthDp < PHONE_BREAKPOINT_DP -> WorkspaceFormFactor.PHONE
        else -> WorkspaceFormFactor.TABLET
      }
    val largeText = viewport.fontScale >= LARGE_TEXT_SCALE
    val regions =
      if (hinge == null) {
        listOf(WorkspaceContentRegion(startDp = 0f, widthDp = viewport.widthDp.toFloat()))
      } else {
        listOf(
          WorkspaceContentRegion(startDp = 0f, widthDp = hinge.offsetDp.toFloat()),
          WorkspaceContentRegion(
            startDp = (hinge.offsetDp + hinge.widthDp).toFloat(),
            widthDp = (viewport.widthDp - hinge.offsetDp - hinge.widthDp).toFloat(),
          ),
        )
      }
    return WorkspaceShellLayout(
      formFactor = formFactor,
      navigation =
        if (formFactor == WorkspaceFormFactor.PHONE) {
          WorkspaceNavigation.DRAWER
        } else {
          WorkspaceNavigation.COLLAPSIBLE_SIDEBAR
        },
      renderAllPanes = formFactor != WorkspaceFormFactor.PHONE,
      sidebarInitiallyExpanded = formFactor != WorkspaceFormFactor.PHONE && !largeText,
      sidebarWidthDp = if (largeText) 304f else 280f,
      minimumTouchTargetDp = 48f,
      minimumTabHeightDp = if (largeText) 64f else 52f,
      fontScale = viewport.fontScale,
      tabRowScrollable = true,
      compactChrome = !largeText,
      contentRegions = regions,
    )
  }

  private const val PHONE_BREAKPOINT_DP: Int = 600
  private const val LARGE_TEXT_SCALE: Float = 1.5f
}

public data class WorkspaceShellProjection(
  public val visibleSplitIds: List<String>,
  public val visibleStackIds: List<String>,
  public val visibleTabIds: List<String>,
  public val focusedTabId: String,
) {
  public companion object {
    public fun project(
      document: WorkspaceDocument,
      layout: WorkspaceShellLayout,
    ): WorkspaceShellProjection {
      if (!layout.renderAllPanes) {
        val focusedStack =
          findStackContaining(document.root, document.focusedTabId)
            ?: collectStacks(document.root).first()
        return WorkspaceShellProjection(
          visibleSplitIds = emptyList(),
          visibleStackIds = listOf(focusedStack.id),
          visibleTabIds = focusedStack.tabs.map { it.id },
          focusedTabId = document.focusedTabId,
        )
      }
      return WorkspaceShellProjection(
        visibleSplitIds = collectSplits(document.root).map { it.id },
        visibleStackIds = collectStacks(document.root).map { it.id },
        visibleTabIds = allTabIds(document),
        focusedTabId = document.focusedTabId,
      )
    }

    public fun allTabIds(document: WorkspaceDocument): List<String> =
      collectStacks(document.root).flatMap { stack -> stack.tabs.map { it.id } }

    internal fun collectStacks(node: WorkspaceNode): List<TabStackNode> =
      when (node) {
        is TabStackNode -> listOf(node)
        is SplitNode -> collectStacks(node.first) + collectStacks(node.second)
      }

    internal fun collectSplits(node: WorkspaceNode): List<SplitNode> =
      when (node) {
        is TabStackNode -> emptyList()
        is SplitNode -> listOf(node) + collectSplits(node.first) + collectSplits(node.second)
      }

    internal fun findStackContaining(
      node: WorkspaceNode,
      tabId: String,
    ): TabStackNode? =
      when (node) {
        is TabStackNode -> node.takeIf { stack -> stack.tabs.any { it.id == tabId } }
        is SplitNode -> findStackContaining(node.first, tabId) ?: findStackContaining(node.second, tabId)
      }
  }
}

public data class WorkspaceShellState(
  public val document: WorkspaceDocument,
  public val sidebarExpanded: Boolean,
  public val quarantineReason: String? = null,
)

public sealed interface WorkspaceShellAction {
  public data class FocusTab(
    public val tabId: String,
  ) : WorkspaceShellAction

  public data class CloseTab(
    public val tabId: String,
  ) : WorkspaceShellAction

  public data class Restore(
    public val encoded: String,
  ) : WorkspaceShellAction

  public data object ToggleSidebar : WorkspaceShellAction
}

public object WorkspaceShellReducer {
  public fun reduce(
    state: WorkspaceShellState,
    action: WorkspaceShellAction,
  ): WorkspaceShellState =
    when (action) {
      is WorkspaceShellAction.FocusTab -> {
        state.copy(
          document = WorkspaceModel.focusTab(state.document, action.tabId),
          quarantineReason = null,
        )
      }

      is WorkspaceShellAction.CloseTab -> {
        state.copy(
          document = WorkspaceModel.closeTab(state.document, action.tabId),
          quarantineReason = null,
        )
      }

      is WorkspaceShellAction.Restore -> {
        when (val restored = WorkspacePersistence.restore(action.encoded)) {
          is WorkspaceRestoreResult.Loaded -> {
            state.copy(document = restored.document, quarantineReason = null)
          }

          is WorkspaceRestoreResult.Quarantined -> {
            state.copy(document = restored.fallback, quarantineReason = restored.reason)
          }
        }
      }

      WorkspaceShellAction.ToggleSidebar -> {
        state.copy(sidebarExpanded = !state.sidebarExpanded)
      }
    }
}

public enum class WorkspaceFixtureStatus {
  RUNNING,
  IDLE,
  SCHEDULED,
  OFFLINE,
}

public data class WorkspaceSidebarFixture(
  public val title: String,
  public val subtitle: String,
  public val status: WorkspaceFixtureStatus,
  public val selected: Boolean = false,
  public val unread: Boolean = false,
)

public data class WorkspaceShellFixture(
  public val name: String,
  public val document: WorkspaceDocument,
  public val sidebarItems: List<WorkspaceSidebarFixture>,
)

public object WorkspaceShellFixtures {
  public fun nestedWorkspace(): WorkspaceShellFixture =
    WorkspaceShellFixture(
      name = "Aurora control room",
      document =
        WorkspaceDocument(
          revision = 12,
          root =
            SplitNode(
              id = "outer-split",
              axis = SplitAxis.HORIZONTAL,
              ratio = 0.56f,
              first =
                TabStackNode(
                  id = "build-stack",
                  activeTabId = "build",
                  tabs =
                    listOf(
                      fixtureTab("build", "Build room", TargetKind.SESSION_RICH, "session-build"),
                      fixtureTab("logs", "Live logs", TargetKind.SESSION_TUI, "session-build"),
                    ),
                ),
              second =
                SplitNode(
                  id = "right-split",
                  axis = SplitAxis.VERTICAL,
                  ratio = 0.52f,
                  first =
                    TabStackNode(
                      id = "notes-stack",
                      activeTabId = "notes",
                      tabs = listOf(fixtureTab("notes", "Launch notes", TargetKind.EMPTY)),
                    ),
                  second =
                    TabStackNode(
                      id = "diagnostics-stack",
                      activeTabId = "diagnostics",
                      tabs = listOf(fixtureTab("diagnostics", "Diagnostics", TargetKind.DIAGNOSTICS)),
                    ),
                ),
            ),
          focusedTabId = "build",
        ),
      sidebarItems =
        listOf(
          WorkspaceSidebarFixture("Build room", "aurora · running", WorkspaceFixtureStatus.RUNNING, selected = true),
          WorkspaceSidebarFixture("Release notes", "ms-mac · idle", WorkspaceFixtureStatus.IDLE, unread = true),
          WorkspaceSidebarFixture("Nightly checks", "helsinki · in 18m", WorkspaceFixtureStatus.SCHEDULED),
          WorkspaceSidebarFixture("Field laptop", "offline · 34m", WorkspaceFixtureStatus.OFFLINE),
        ),
    )

  private fun fixtureTab(
    id: String,
    title: String,
    kind: TargetKind,
    sessionId: String? = null,
  ): WorkspaceTab =
    WorkspaceTab(
      id = id,
      title = title,
      target =
        WorkspaceTarget(
          kind = kind,
          hostId = sessionId?.let { "host-aurora" },
          sessionId = sessionId,
        ),
    )
}

public data class WorkspaceSemanticsSnapshot(
  public val controlLabels: Set<String>,
  public val regionLabels: Set<String>,
)

public object WorkspaceShellSemantics {
  public fun describe(
    fixture: WorkspaceShellFixture,
    layout: WorkspaceShellLayout,
  ): WorkspaceSemanticsSnapshot {
    val controls = linkedSetOf<String>()
    controls +=
      if (layout.navigation == WorkspaceNavigation.DRAWER) {
        "Open navigation drawer"
      } else {
        "Collapse session sidebar"
      }
    val regions = linkedSetOf<String>()
    WorkspaceShellProjection.collectStacks(fixture.document.root).forEach { stack ->
      stack.tabs.forEach { tab ->
        controls += "Tab ${tab.title}${if (tab.id == fixture.document.focusedTabId) ", selected" else ""}"
        controls += "Close ${tab.title}"
      }
      val active = stack.tabs.firstOrNull { it.id == stack.activeTabId } ?: stack.tabs.first()
      regions += "Pane ${active.title}"
    }
    WorkspaceShellProjection.collectSplits(fixture.document.root).forEach { split ->
      controls += "Resize ${split.axis.name.lowercase()} split"
    }
    return WorkspaceSemanticsSnapshot(controlLabels = controls, regionLabels = regions)
  }
}
