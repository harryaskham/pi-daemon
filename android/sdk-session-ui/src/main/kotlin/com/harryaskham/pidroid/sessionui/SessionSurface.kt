package com.harryaskham.pidroid.sessionui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.harryaskham.pidroid.sdk.core.CacheFreshness

private val NordCanvas = Color(0xFF0A1019)
private val NordSurface = Color(0xFF111A27)
private val NordElevated = Color(0xFF192536)
private val NordBorder = Color(0xFF2B3B52)
private val NordPrimary = Color(0xFFEAF0F8)
private val NordMuted = Color(0xFF91A2BA)
private val NordAccent = Color(0xFF88D5E7)
private val NordAccentSoft = Color(0xFF173A49)
private val NordGreen = Color(0xFFA7D8A2)
private val NordYellow = Color(0xFFE9CB88)
private val NordRed = Color(0xFFE58D96)
private val NordPurple = Color(0xFFC9A3E6)

private val SessionColors =
  darkColorScheme(
    primary = NordAccent,
    onPrimary = NordCanvas,
    secondary = NordPurple,
    background = NordCanvas,
    onBackground = NordPrimary,
    surface = NordSurface,
    onSurface = NordPrimary,
    surfaceVariant = NordElevated,
    onSurfaceVariant = NordMuted,
    outline = NordBorder,
    error = NordRed,
  )

public enum class SessionSurfaceChrome {
  READONLY,
  INTERACTIVE,
}

/**
 * Reusable Pi Daemon session view. It consumes already-decoded inert state; [chrome] changes only
 * presentation wording/banner space and never adds transport or command authority by itself.
 */
@Composable
public fun SessionSurface(
  state: SessionSurfaceState,
  layout: SessionSurfaceLayout,
  modifier: Modifier = Modifier,
  chrome: SessionSurfaceChrome = SessionSurfaceChrome.READONLY,
) {
  val density = LocalDensity.current
  CompositionLocalProvider(LocalDensity provides Density(density.density, layout.fontScale)) {
    MaterialTheme(colorScheme = SessionColors) {
      Surface(
        modifier =
          modifier
            .fillMaxSize()
            .semantics {
              contentDescription =
                "${if (chrome == SessionSurfaceChrome.READONLY) "Readonly" else "Interactive"} session ${state.session.title} on ${state.host.displayName}"
            },
        color = NordCanvas,
      ) {
        Column(Modifier.fillMaxSize()) {
          SessionTopBar(state, chrome)
          if (layout.formFactor == SessionSurfaceFormFactor.TABLET) {
            Row(
              modifier = Modifier.fillMaxSize().padding(layout.contentPaddingDp.dp),
              horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
              InventoryPanel(
                items = state.inventory,
                selectedId = state.session.inventoryId,
                modifier = Modifier.width(layout.inventoryWidthDp.dp).fillMaxHeight(),
              )
              SessionContent(
                state,
                layout,
                Modifier.weight(1f).fillMaxHeight(),
                showReadonlyBanner = chrome == SessionSurfaceChrome.READONLY,
              )
            }
          } else {
            Column(
              modifier = Modifier.fillMaxSize().padding(layout.contentPaddingDp.dp),
              verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              CompactInventory(state.inventory, state.session.inventoryId)
              SessionContent(
                state,
                layout,
                Modifier.weight(1f).fillMaxWidth(),
                showReadonlyBanner = chrome == SessionSurfaceChrome.READONLY,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun SessionTopBar(
  state: SessionSurfaceState,
  chrome: SessionSurfaceChrome,
) {
  Row(
    modifier = Modifier.fillMaxWidth().height(72.dp).padding(horizontal = 18.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(Modifier.size(12.dp).clip(CircleShape).background(freshnessColor(state.host.freshness)))
    Column(Modifier.weight(1f)) {
      Text(
        "PI DROID · ${chrome.name}",
        color = NordAccent,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.4.sp,
      )
      Text(
        state.session.title,
        color = NordPrimary,
        fontSize = 19.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Surface(
      modifier =
        Modifier.semantics {
          contentDescription = "Host ${state.host.displayName}, ${state.freshnessLabel}"
        },
      color = freshnessColor(state.host.freshness).copy(alpha = 0.14f),
      shape = RoundedCornerShape(999.dp),
      border = BorderStroke(1.dp, freshnessColor(state.host.freshness).copy(alpha = 0.5f)),
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.End,
      ) {
        Text(state.host.displayName, color = NordPrimary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(state.freshnessLabel, color = freshnessColor(state.host.freshness), fontSize = 10.sp, fontWeight = FontWeight.Bold)
      }
    }
  }
}

@Composable
private fun CompactInventory(
  items: List<SessionInventoryItem>,
  selectedId: String,
) {
  Surface(
    modifier =
      Modifier
        .fillMaxWidth()
        .semantics { contentDescription = inventoryDescription(items.size) },
    color = NordSurface,
    shape = RoundedCornerShape(16.dp),
    border = BorderStroke(1.dp, NordBorder),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text("SESSIONS", color = NordMuted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
      items.take(3).forEach { item ->
        InventoryPill(item, selected = item.inventoryId == selectedId)
      }
    }
  }
}

@Composable
private fun InventoryPanel(
  items: List<SessionInventoryItem>,
  selectedId: String,
  modifier: Modifier,
) {
  Surface(
    modifier = modifier.semantics { contentDescription = inventoryDescription(items.size) },
    color = NordSurface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, NordBorder),
  ) {
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text("SESSION INVENTORY", color = NordMuted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.3.sp)
      Text("Readonly hosts", color = NordPrimary, fontSize = 19.sp, fontWeight = FontWeight.Bold)
      items.forEach { item -> InventoryCard(item, selected = item.inventoryId == selectedId) }
      Spacer(Modifier.weight(1f))
      Surface(color = NordElevated, shape = RoundedCornerShape(14.dp)) {
        Text(
          "Cached content is never presented as live without current host authority.",
          modifier = Modifier.padding(12.dp),
          color = NordMuted,
          fontSize = 11.sp,
          lineHeight = 16.sp,
        )
      }
    }
  }
}

@Composable
private fun InventoryPill(
  item: SessionInventoryItem,
  selected: Boolean,
) {
  Surface(
    color = if (selected) NordAccentSoft else NordElevated,
    shape = RoundedCornerShape(999.dp),
    border = if (selected) BorderStroke(1.dp, NordAccent.copy(alpha = 0.5f)) else null,
  ) {
    Text(
      item.title,
      modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp),
      color = if (selected) NordAccent else NordMuted,
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
    )
  }
}

@Composable
private fun InventoryCard(
  item: SessionInventoryItem,
  selected: Boolean,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = if (selected) NordAccentSoft else Color.Transparent,
    shape = RoundedCornerShape(14.dp),
    border = if (selected) BorderStroke(1.dp, NordAccent.copy(alpha = 0.4f)) else null,
  ) {
    Row(
      modifier = Modifier.padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Box(Modifier.size(9.dp).clip(CircleShape).background(if (item.unread) NordYellow else NordGreen))
      Column(Modifier.weight(1f)) {
        Text(item.title, color = NordPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(item.projectLabel ?: "No project", color = NordMuted, fontSize = 11.sp, maxLines = 1)
      }
      Text(item.state.uppercase(), color = NordAccent, fontSize = 9.sp, fontWeight = FontWeight.Bold)
    }
  }
}

@Composable
private fun SessionContent(
  state: SessionSurfaceState,
  layout: SessionSurfaceLayout,
  modifier: Modifier,
  showReadonlyBanner: Boolean,
) {
  Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
    SessionInfoCard(state.session)
    if (showReadonlyBanner) {
      ReadonlyBanner()
    }
    TranscriptList(state.records, layout, Modifier.weight(1f).fillMaxWidth())
  }
}

@Composable
private fun SessionInfoCard(info: SessionInfoModel) {
  Surface(
    modifier =
      Modifier
        .fillMaxWidth()
        .semantics { contentDescription = "Session information ${info.title}" },
    color = NordSurface,
    shape = RoundedCornerShape(18.dp),
    border = BorderStroke(1.dp, NordBorder),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 16.dp, vertical = 13.dp),
      horizontalArrangement = Arrangement.spacedBy(18.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      InfoMetric("PROJECT", info.projectLabel ?: "—")
      InfoMetric("STATE", info.state)
      InfoMetric("MODEL", info.modelLabel ?: "unavailable")
      InfoMetric("MESSAGES", info.messageCount.toString())
      InfoMetric("TOOLS", info.toolCallCount.toString())
    }
  }
}

@Composable
private fun InfoMetric(
  label: String,
  value: String,
) {
  Column {
    Text(label, color = NordMuted, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
    Text(value, color = NordPrimary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
  }
}

@Composable
private fun ReadonlyBanner() {
  Surface(
    modifier =
      Modifier
        .fillMaxWidth()
        .semantics { contentDescription = "Readonly surface; commands unavailable" },
    color = NordAccentSoft,
    shape = RoundedCornerShape(14.dp),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Box(Modifier.size(8.dp).clip(CircleShape).background(NordAccent))
      Text("READONLY SESSION VIEW", color = NordAccent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
      Text("Inventory, information and transcript only", color = NordMuted, fontSize = 11.sp)
    }
  }
}

@Composable
private fun TranscriptList(
  records: List<TranscriptRecord>,
  layout: SessionSurfaceLayout,
  modifier: Modifier,
) {
  Surface(
    modifier = modifier,
    color = NordSurface,
    shape = RoundedCornerShape(18.dp),
    border = BorderStroke(1.dp, NordBorder),
  ) {
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
      contentPadding =
        androidx.compose.foundation.layout
          .PaddingValues(vertical = 12.dp),
    ) {
      items(records, key = { it.key.value }) { record ->
        TranscriptRecordCard(record, layout)
      }
    }
  }
}

@Composable
private fun TranscriptRecordCard(
  record: TranscriptRecord,
  layout: SessionSurfaceLayout,
) {
  val accent = roleColor(record.role)
  Surface(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = layout.minimumRecordHeightDp.dp)
        .semantics {
          contentDescription = "Transcript ${record.role.wireValue} ${record.key.value}"
        },
    color = if (record.role == TranscriptRole.USER) NordElevated else NordCanvas.copy(alpha = 0.65f),
    shape = RoundedCornerShape(16.dp),
    border = BorderStroke(1.dp, accent.copy(alpha = 0.28f)),
  ) {
    Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Box(Modifier.size(10.dp).clip(CircleShape).background(accent))
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(record.role.wireValue.uppercase(), color = accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
          Spacer(Modifier.weight(1f))
          Text(record.state.uppercase(), color = NordMuted, fontSize = 9.sp, fontWeight = FontWeight.Bold)
        }
        record.blocks.forEach { block ->
          Text(
            text = block.text + if (block.truncated) " …" else "",
            color = NordPrimary,
            fontSize = 13.sp,
            lineHeight = 19.sp,
            fontFamily =
              if (block.type == TranscriptBlockType.CODE ||
                record.role == TranscriptRole.TOOL
              ) {
                FontFamily.Monospace
              } else {
                FontFamily.Default
              },
          )
        }
      }
    }
  }
}

private fun freshnessColor(freshness: CacheFreshness): Color =
  when (freshness) {
    CacheFreshness.FRESH -> NordGreen
    CacheFreshness.RECONNECTING -> NordYellow
    CacheFreshness.STALE -> NordYellow
    CacheFreshness.RESYNCING -> NordAccent
    CacheFreshness.OFFLINE_CACHED -> NordMuted
    CacheFreshness.REMOVED -> NordRed
  }

private fun roleColor(role: TranscriptRole): Color =
  when (role) {
    TranscriptRole.USER -> NordAccent
    TranscriptRole.ASSISTANT -> NordGreen
    TranscriptRole.TOOL -> NordPurple
    TranscriptRole.SYSTEM -> NordYellow
    TranscriptRole.UNKNOWN -> NordMuted
  }

private fun inventoryDescription(size: Int): String = "Session inventory, $size ${if (size == 1) "item" else "items"}"
