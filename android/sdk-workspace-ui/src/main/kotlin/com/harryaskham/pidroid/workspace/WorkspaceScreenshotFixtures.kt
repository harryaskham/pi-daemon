package com.harryaskham.pidroid.workspace

public data class WorkspaceScreenshotProfile(
  public val id: String,
  public val title: String,
  public val viewport: WorkspaceViewport,
  public val windowWidthPx: Int,
  public val windowHeightPx: Int,
  public val sidebarExpanded: Boolean,
)

public object WorkspaceScreenshotFixtures {
  public val all: List<WorkspaceScreenshotProfile> =
    listOf(
      WorkspaceScreenshotProfile(
        id = "phone",
        title = "Pi Droid · Phone workspace fixture",
        viewport = WorkspaceViewport(widthDp = 411, heightDp = 891),
        windowWidthPx = 430,
        windowHeightPx = 900,
        sidebarExpanded = false,
      ),
      WorkspaceScreenshotProfile(
        id = "tablet",
        title = "Pi Droid · Tablet workspace fixture",
        viewport = WorkspaceViewport(widthDp = 1_024, heightDp = 768),
        windowWidthPx = 1_180,
        windowHeightPx = 820,
        sidebarExpanded = true,
      ),
      WorkspaceScreenshotProfile(
        id = "foldable",
        title = "Pi Droid · Foldable workspace fixture",
        viewport =
          WorkspaceViewport(
            widthDp = 1_344,
            heightDp = 840,
            hinge = WorkspaceHinge(offsetDp = 656, widthDp = 32),
          ),
        windowWidthPx = 1_360,
        windowHeightPx = 840,
        sidebarExpanded = true,
      ),
      WorkspaceScreenshotProfile(
        id = "nested",
        title = "Pi Droid · Nested tabs-in-splits fixture",
        viewport = WorkspaceViewport(widthDp = 1_280, heightDp = 840),
        windowWidthPx = 1_440,
        windowHeightPx = 900,
        sidebarExpanded = false,
      ),
      WorkspaceScreenshotProfile(
        id = "large-text",
        title = "Pi Droid · Large text accessibility fixture",
        viewport = WorkspaceViewport(widthDp = 720, heightDp = 960, fontScale = 2f),
        windowWidthPx = 900,
        windowHeightPx = 900,
        sidebarExpanded = false,
      ),
    )

  public fun profile(id: String): WorkspaceScreenshotProfile =
    all.firstOrNull { it.id == id }
      ?: throw IllegalArgumentException("unknown workspace screenshot profile '$id'")
}
