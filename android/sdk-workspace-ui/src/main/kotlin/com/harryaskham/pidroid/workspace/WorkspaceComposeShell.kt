package com.harryaskham.pidroid.workspace

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val NordCanvas = Color(0xFF0C111B)
private val NordSurface = Color(0xFF121A28)
private val NordElevated = Color(0xFF1A2536)
private val NordBorder = Color(0xFF2A3850)
private val NordPrimary = Color(0xFFE8EEF7)
private val NordMuted = Color(0xFF91A0B7)
private val NordAccent = Color(0xFF82D2E5)
private val NordAccentSoft = Color(0xFF183B49)
private val NordGreen = Color(0xFFA8D8A0)
private val NordMagenta = Color(0xFFCB9DE2)
private val NordWarning = Color(0xFFE7C987)
private val NordError = Color(0xFFE18B93)

private val WorkspaceColors =
  darkColorScheme(
    primary = NordAccent,
    onPrimary = NordCanvas,
    secondary = NordMagenta,
    background = NordCanvas,
    onBackground = NordPrimary,
    surface = NordSurface,
    onSurface = NordPrimary,
    surfaceVariant = NordElevated,
    onSurfaceVariant = NordMuted,
    outline = NordBorder,
    error = NordError,
  )

@Composable
public fun PiDroidWorkspaceShell(
  fixture: WorkspaceShellFixture,
  layout: WorkspaceShellLayout,
  state: WorkspaceShellState,
  modifier: Modifier = Modifier,
  onAction: (WorkspaceShellAction) -> Unit = {},
) {
  val density = LocalDensity.current
  CompositionLocalProvider(LocalDensity provides Density(density.density, layout.fontScale)) {
    MaterialTheme(colorScheme = WorkspaceColors) {
      Surface(modifier = modifier.fillMaxSize(), color = NordCanvas) {
        Column(modifier = Modifier.fillMaxSize()) {
          WorkspaceTopBar(fixture, layout, state, onAction)
          Row(modifier = Modifier.fillMaxSize().padding(10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WorkspaceNavigationChrome(fixture, layout, state, onAction)
            Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
              when (layout.formFactor) {
                WorkspaceFormFactor.PHONE -> PhoneWorkspace(state.document, layout, onAction)
                WorkspaceFormFactor.TABLET -> WorkspaceNodeView(state.document.root, state.document, layout, onAction)
                WorkspaceFormFactor.FOLDABLE -> FoldableWorkspace(state.document, layout, onAction)
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun WorkspaceTopBar(
  fixture: WorkspaceShellFixture,
  layout: WorkspaceShellLayout,
  state: WorkspaceShellState,
  onAction: (WorkspaceShellAction) -> Unit,
) {
  val navigationLabel =
    when {
      layout.navigation == WorkspaceNavigation.DRAWER && state.sidebarExpanded -> "Close navigation drawer"
      layout.navigation == WorkspaceNavigation.DRAWER -> "Open navigation drawer"
      state.sidebarExpanded -> "Collapse session sidebar"
      else -> "Expand session sidebar"
    }
  Row(
    modifier = Modifier.fillMaxWidth().height(68.dp).padding(horizontal = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Surface(
      modifier =
        Modifier
          .size(layout.minimumTouchTargetDp.dp)
          .semantics {
            contentDescription = navigationLabel
            role = Role.Button
          }.clickable { onAction(WorkspaceShellAction.ToggleSidebar) },
      color = NordElevated,
      shape = RoundedCornerShape(14.dp),
      border = BorderStroke(1.dp, NordBorder),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Text(if (state.sidebarExpanded) "‹" else "☰", color = NordAccent, fontSize = 22.sp)
      }
    }
    Spacer(Modifier.width(14.dp))
    Column(modifier = Modifier.weight(1f)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(NordAccent))
        Spacer(Modifier.width(9.dp))
        Text("PI DROID", color = NordAccent, fontWeight = FontWeight.Black, letterSpacing = 2.sp)
      }
      Text(
        fixture.name,
        color = NordPrimary,
        fontWeight = FontWeight.SemiBold,
        maxLines = if (layout.compactChrome) 1 else 2,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Surface(color = NordAccentSoft, shape = RoundedCornerShape(999.dp)) {
      Text(
        when (layout.formFactor) {
          WorkspaceFormFactor.PHONE -> "PHONE"
          WorkspaceFormFactor.TABLET -> "TABLET"
          WorkspaceFormFactor.FOLDABLE -> "FOLDABLE"
        },
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
        color = NordAccent,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
      )
    }
  }
}

@Composable
private fun WorkspaceNavigationChrome(
  fixture: WorkspaceShellFixture,
  layout: WorkspaceShellLayout,
  state: WorkspaceShellState,
  onAction: (WorkspaceShellAction) -> Unit,
) {
  if (layout.navigation == WorkspaceNavigation.DRAWER) {
    AnimatedVisibility(visible = state.sidebarExpanded) {
      WorkspaceSidebar(fixture, layout, expanded = true)
    }
    return
  }
  if (state.sidebarExpanded) {
    WorkspaceSidebar(fixture, layout, expanded = true)
  } else {
    WorkspaceSidebar(fixture, layout, expanded = false, onExpand = { onAction(WorkspaceShellAction.ToggleSidebar) })
  }
}

@Composable
private fun WorkspaceSidebar(
  fixture: WorkspaceShellFixture,
  layout: WorkspaceShellLayout,
  expanded: Boolean,
  onExpand: (() -> Unit)? = null,
) {
  val width = if (expanded) layout.sidebarWidthDp.dp else 72.dp
  Surface(
    modifier = Modifier.width(width).fillMaxHeight(),
    color = NordSurface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, NordBorder),
  ) {
    Column(modifier = Modifier.padding(if (expanded) 14.dp else 10.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
      if (expanded) {
        Text("SESSIONS", color = NordMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.6.sp)
        Text("Fixture inventory", color = NordPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold)
      } else {
        Surface(
          modifier =
            Modifier
              .size(48.dp)
              .semantics {
                contentDescription = "Expand session sidebar from rail"
                role = Role.Button
              }.clickable(enabled = onExpand != null) { onExpand?.invoke() },
          color = NordAccentSoft,
          shape = RoundedCornerShape(14.dp),
        ) {
          Box(contentAlignment = Alignment.Center) { Text("›", color = NordAccent, fontSize = 24.sp) }
        }
      }
      Spacer(Modifier.height(2.dp))
      fixture.sidebarItems.forEachIndexed { index, item ->
        SidebarItem(item = item, expanded = expanded, shortcut = index + 1)
      }
      Spacer(Modifier.weight(1f))
      if (expanded) {
        Surface(color = NordElevated, shape = RoundedCornerShape(14.dp)) {
          Column(Modifier.padding(12.dp)) {
            Text("LOCAL FIXTURE", color = NordAccent, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            Text("No live host or session transport", color = NordMuted, fontSize = 12.sp)
          }
        }
      }
    }
  }
}

@Composable
private fun SidebarItem(
  item: WorkspaceSidebarFixture,
  expanded: Boolean,
  shortcut: Int,
) {
  val statusColor =
    when (item.status) {
      WorkspaceFixtureStatus.RUNNING -> NordAccent
      WorkspaceFixtureStatus.IDLE -> NordGreen
      WorkspaceFixtureStatus.SCHEDULED -> NordMagenta
      WorkspaceFixtureStatus.OFFLINE -> NordMuted
    }
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = if (item.selected) NordAccentSoft else Color.Transparent,
    shape = RoundedCornerShape(14.dp),
    border = if (item.selected) BorderStroke(1.dp, NordAccent.copy(alpha = 0.36f)) else null,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = if (expanded) 11.dp else 8.dp, vertical = 11.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(contentAlignment = Alignment.Center) {
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(11.dp)).background(NordElevated))
        Text(shortcut.toString(), color = NordPrimary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Box(
          Modifier
            .align(Alignment.BottomEnd)
            .size(9.dp)
            .clip(CircleShape)
            .background(statusColor)
            .border(2.dp, NordSurface, CircleShape),
        )
      }
      if (expanded) {
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
              item.title,
              modifier = Modifier.weight(1f),
              color = NordPrimary,
              fontSize = 13.sp,
              fontWeight = if (item.selected) FontWeight.Bold else FontWeight.Medium,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
            if (item.unread) {
              Box(Modifier.size(7.dp).clip(CircleShape).background(NordPrimary))
            }
          }
          Text(item.subtitle, color = NordMuted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

@Composable
private fun PhoneWorkspace(
  document: WorkspaceDocument,
  layout: WorkspaceShellLayout,
  onAction: (WorkspaceShellAction) -> Unit,
) {
  val stack =
    WorkspaceShellProjection.findStackContaining(document.root, document.focusedTabId)
      ?: WorkspaceShellProjection.collectStacks(document.root).first()
  WorkspaceStackView(stack = stack, document = document, layout = layout, onAction = onAction, modifier = Modifier.fillMaxSize())
}

@Composable
private fun FoldableWorkspace(
  document: WorkspaceDocument,
  layout: WorkspaceShellLayout,
  onAction: (WorkspaceShellAction) -> Unit,
) {
  val root = document.root
  if (root !is SplitNode) {
    WorkspaceNodeView(root, document, layout, onAction)
    return
  }
  val hingeWidth =
    layout.contentRegions
      .zipWithNext()
      .firstOrNull()
      ?.let { (first, second) -> second.startDp - first.endDp } ?: 0f
  Row(Modifier.fillMaxSize()) {
    WorkspaceNodeView(root.first, document, layout, onAction, Modifier.weight(1f))
    Box(
      Modifier
        .width(hingeWidth.dp.coerceAtLeast(12.dp))
        .fillMaxHeight()
        .padding(horizontal = 5.dp)
        .clip(RoundedCornerShape(999.dp))
        .background(NordBorder.copy(alpha = 0.65f)),
    )
    WorkspaceNodeView(root.second, document, layout, onAction, Modifier.weight(1f))
  }
}

@Composable
private fun WorkspaceNodeView(
  node: WorkspaceNode,
  document: WorkspaceDocument,
  layout: WorkspaceShellLayout,
  onAction: (WorkspaceShellAction) -> Unit,
  modifier: Modifier = Modifier,
) {
  when (node) {
    is TabStackNode -> {
      WorkspaceStackView(node, document, layout, onAction, modifier)
    }

    is SplitNode -> {
      val resizeLabel = "Resize ${node.axis.name.lowercase()} split"
      if (node.axis == SplitAxis.HORIZONTAL) {
        Row(modifier.fillMaxSize()) {
          WorkspaceNodeView(node.first, document, layout, onAction, Modifier.weight(node.ratio))
          SplitHandle(resizeLabel, vertical = true)
          WorkspaceNodeView(node.second, document, layout, onAction, Modifier.weight(1f - node.ratio))
        }
      } else {
        Column(modifier.fillMaxSize()) {
          WorkspaceNodeView(node.first, document, layout, onAction, Modifier.weight(node.ratio))
          SplitHandle(resizeLabel, vertical = false)
          WorkspaceNodeView(node.second, document, layout, onAction, Modifier.weight(1f - node.ratio))
        }
      }
    }
  }
}

@Composable
private fun SplitHandle(
  label: String,
  vertical: Boolean,
) {
  Box(
    modifier =
      (if (vertical) Modifier.width(12.dp).fillMaxHeight() else Modifier.height(12.dp).fillMaxWidth())
        .semantics {
          contentDescription = label
          role = Role.Button
        }.padding(if (vertical) 5.dp else 0.dp)
        .background(NordBorder.copy(alpha = 0.7f), RoundedCornerShape(999.dp)),
  )
}

@Composable
private fun WorkspaceStackView(
  stack: TabStackNode,
  document: WorkspaceDocument,
  layout: WorkspaceShellLayout,
  onAction: (WorkspaceShellAction) -> Unit,
  modifier: Modifier,
) {
  val active = stack.tabs.firstOrNull { it.id == stack.activeTabId } ?: stack.tabs.first()
  Surface(
    modifier = modifier.padding(3.dp).semantics { contentDescription = "Pane ${active.title}" },
    color = NordSurface,
    shape = RoundedCornerShape(18.dp),
    border =
      BorderStroke(
        if (active.id ==
          document.focusedTabId
        ) {
          1.5.dp
        } else {
          1.dp
        },
        if (active.id == document.focusedTabId) NordAccent else NordBorder,
      ),
  ) {
    Column(Modifier.fillMaxSize()) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .height(layout.minimumTabHeightDp.dp)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        stack.tabs.forEach { tab ->
          WorkspaceTabChip(
            tab,
            selected = tab.id == stack.activeTabId,
            focused = tab.id == document.focusedTabId,
            layout = layout,
            onAction = onAction,
          )
        }
      }
      Box(Modifier.fillMaxSize().padding(start = 10.dp, end = 10.dp, bottom = 10.dp)) {
        FixturePaneContent(active, Modifier.fillMaxSize())
      }
    }
  }
}

@Composable
private fun WorkspaceTabChip(
  tab: WorkspaceTab,
  selected: Boolean,
  focused: Boolean,
  layout: WorkspaceShellLayout,
  onAction: (WorkspaceShellAction) -> Unit,
) {
  val tabLabel = "Tab ${tab.title}${if (focused) ", selected" else ""}"
  Surface(
    modifier =
      Modifier
        .height((layout.minimumTabHeightDp - 14f).coerceAtLeast(38f).dp)
        .semantics {
          contentDescription = tabLabel
          role = Role.Tab
        }.clickable { onAction(WorkspaceShellAction.FocusTab(tab.id)) },
    color = if (selected) NordElevated else Color.Transparent,
    shape = RoundedCornerShape(11.dp),
    border = if (selected) BorderStroke(1.dp, NordBorder) else null,
  ) {
    Row(modifier = Modifier.padding(start = 11.dp, end = 5.dp), verticalAlignment = Alignment.CenterVertically) {
      if (selected) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(NordAccent))
        Spacer(Modifier.width(7.dp))
      }
      Text(
        tab.title,
        color = if (selected) NordPrimary else NordMuted,
        fontSize = 12.sp,
        fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
      )
      Spacer(Modifier.width(7.dp))
      Box(
        modifier =
          Modifier
            .size(28.dp)
            .clip(RoundedCornerShape(9.dp))
            .semantics {
              contentDescription = "Close ${tab.title}"
              role = Role.Button
            }.clickable { onAction(WorkspaceShellAction.CloseTab(tab.id)) },
        contentAlignment = Alignment.Center,
      ) {
        Text("×", color = NordMuted, fontSize = 16.sp)
      }
    }
  }
}

@Composable
private fun FixturePaneContent(
  tab: WorkspaceTab,
  modifier: Modifier,
) {
  Surface(modifier = modifier, color = NordCanvas.copy(alpha = 0.72f), shape = RoundedCornerShape(14.dp)) {
    when (tab.target.kind) {
      TargetKind.SESSION_RICH -> BuildFixture(tab)
      TargetKind.SESSION_TUI -> LogsFixture(tab)
      TargetKind.DIAGNOSTICS -> DiagnosticsFixture(tab)
      else -> NotesFixture(tab)
    }
  }
}

@Composable
private fun BuildFixture(tab: WorkspaceTab) {
  Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    FixtureHeading(tab.title, "WORKSPACE FIXTURE · NO LIVE SESSION")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      MetricCard("MODEL", "Recursive", NordAccent, Modifier.weight(1f))
      MetricCard("STATE", "Green", NordGreen, Modifier.weight(1f))
      MetricCard("PANES", "3", NordMagenta, Modifier.weight(1f))
    }
    Surface(color = NordElevated, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, NordBorder)) {
      Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Deterministic workspace", color = NordPrimary, fontWeight = FontWeight.Bold)
        Text("Tabs and splits are projected from immutable fixture state.", color = NordMuted, fontSize = 12.sp)
        ProgressRail(0.82f, NordAccent)
      }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
      StatusPill("9 model tests", NordGreen)
      StatusPill("6 layout tests", NordAccent)
      StatusPill("offline fixture", NordWarning)
    }
  }
}

@Composable
private fun LogsFixture(tab: WorkspaceTab) {
  Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
    FixtureHeading(tab.title, "STATIC TERMINAL FIXTURE")
    Surface(color = Color(0xFF090D14), shape = RoundedCornerShape(13.dp), border = BorderStroke(1.dp, NordBorder)) {
      Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        listOf(
          "12:21  workspace:model       9 / 9 green",
          "12:21  workspace:layout      6 / 6 green",
          "12:22  fixture:compose       ready",
          "12:22  transport             intentionally absent",
        ).forEachIndexed { index, line ->
          Text(line, color = if (index == 2) NordAccent else NordMuted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
      }
    }
  }
}

@Composable
private fun DiagnosticsFixture(tab: WorkspaceTab) {
  Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    FixtureHeading(tab.title, "BOUNDED LOCAL METRICS")
    listOf(
      Triple("Model invariants", "15 checks", NordGreen),
      Triple("Workspace depth", "3 / 32", NordAccent),
      Triple("Fixture tabs", "4 / 64", NordMagenta),
    ).forEach { (label, value, color) ->
      Surface(color = NordElevated, shape = RoundedCornerShape(12.dp)) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
          Box(Modifier.size(8.dp).clip(CircleShape).background(color))
          Spacer(Modifier.width(9.dp))
          Text(label, modifier = Modifier.weight(1f), color = NordMuted, fontSize = 11.sp)
          Text(value, color = NordPrimary, fontWeight = FontWeight.Bold, fontSize = 11.sp)
        }
      }
    }
  }
}

@Composable
private fun NotesFixture(tab: WorkspaceTab) {
  Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    FixtureHeading(tab.title, "LOCAL WORKSPACE NOTES")
    listOf(
      "Phone uses one focused pane",
      "Tablet keeps nested splits visible",
      "Foldable content avoids the hinge",
    ).forEachIndexed { index, note ->
      Row(verticalAlignment = Alignment.CenterVertically) {
        Surface(color = if (index == 0) NordAccentSoft else NordElevated, shape = RoundedCornerShape(9.dp)) {
          Text(
            "${index + 1}",
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
            color = NordAccent,
            fontWeight = FontWeight.Bold,
          )
        }
        Spacer(Modifier.width(10.dp))
        Text(note, color = NordPrimary, fontSize = 12.sp)
      }
    }
  }
}

@Composable
private fun FixtureHeading(
  title: String,
  eyebrow: String,
) {
  Text(eyebrow, color = NordAccent, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
  Text(title, color = NordPrimary, fontSize = 20.sp, fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun MetricCard(
  label: String,
  value: String,
  color: Color,
  modifier: Modifier,
) {
  Surface(modifier = modifier.widthIn(min = 74.dp), color = NordElevated, shape = RoundedCornerShape(13.dp)) {
    Column(Modifier.padding(12.dp)) {
      Text(label, color = NordMuted, fontSize = 9.sp, fontWeight = FontWeight.Bold)
      Text(value, color = color, fontSize = 14.sp, fontWeight = FontWeight.Black, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

@Composable
private fun ProgressRail(
  progress: Float,
  color: Color,
) {
  Box(
    Modifier
      .fillMaxWidth()
      .height(5.dp)
      .clip(CircleShape)
      .background(NordBorder),
  ) {
    Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).fillMaxHeight().background(color))
  }
}

@Composable
private fun StatusPill(
  label: String,
  color: Color,
) {
  Surface(color = color.copy(alpha = 0.12f), shape = RoundedCornerShape(999.dp), border = BorderStroke(1.dp, color.copy(alpha = 0.28f))) {
    Text(
      label,
      modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
      color = color,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
    )
  }
}
