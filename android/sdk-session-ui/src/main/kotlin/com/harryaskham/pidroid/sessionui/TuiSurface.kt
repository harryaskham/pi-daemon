package com.harryaskham.pidroid.sessionui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val TuiCanvas = Color(0xFF080D14)
private val TuiSurfaceColor = Color(0xFF101923)
private val TuiElevated = Color(0xFF172433)
private val TuiBorder = Color(0xFF2A3A50)
private val TuiText = Color(0xFFE8EEF6)
private val TuiMuted = Color(0xFF8EA0B7)
private val TuiAccent = Color(0xFF88D5E7)
private val TuiGreen = Color(0xFFA7D8A2)
private val TuiYellow = Color(0xFFE9CB88)

private val TuiColors =
  darkColorScheme(
    primary = TuiAccent,
    onPrimary = TuiCanvas,
    background = TuiCanvas,
    onBackground = TuiText,
    surface = TuiSurfaceColor,
    onSurface = TuiText,
    surfaceVariant = TuiElevated,
    onSurfaceVariant = TuiMuted,
    outline = TuiBorder,
  )

/**
 * Inert canonical terminal projection. Input and resize are represented by TuiInteractionIntent
 * values outside this renderer; this surface performs no transport or authority mutation.
 */
@Composable
public fun TuiSurface(
  state: TuiFrameState,
  layout: TuiSurfaceLayout,
  modifier: Modifier = Modifier,
) {
  val density = LocalDensity.current
  CompositionLocalProvider(LocalDensity provides Density(density.density, layout.fontScale)) {
    MaterialTheme(colorScheme = TuiColors) {
      Surface(
        modifier =
          modifier
            .fillMaxSize()
            .semantics {
              contentDescription =
                "Terminal ${state.title ?: "Untitled"}, session ${state.identity.sessionId} generation ${state.identity.generation}"
            },
        color = TuiCanvas,
      ) {
        Column(Modifier.fillMaxSize()) {
          TuiHeader(state)
          if (state.phase == TuiFramePhase.REPLAY_GAP) {
            ReplayGapPanel(state, Modifier.weight(1f).fillMaxWidth())
          } else {
            TerminalRows(
              state = state,
              layout = layout,
              modifier =
                Modifier
                  .weight(1f)
                  .fillMaxWidth()
                  .padding(layout.terminalPaddingDp.dp),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun TuiHeader(state: TuiFrameState) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(
      Modifier
        .size(10.dp)
        .clip(CircleShape)
        .background(if (state.phase == TuiFramePhase.LIVE) TuiGreen else TuiYellow),
    )
    Column(Modifier.weight(1f)) {
      Text(
        "PI DROID · TUI",
        color = TuiAccent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.3.sp,
      )
      Text(
        state.title ?: "Untitled terminal",
        color = TuiText,
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        "${state.dimensions.columns}×${state.dimensions.rows} · cursor ${state.cursor.column + 1}:${state.cursor.row + 1}",
        modifier =
          Modifier.semantics {
            contentDescription =
              "Terminal cursor row ${state.cursor.row + 1} column ${state.cursor.column + 1}, ${state.cursor.shape.name.lowercase()}"
          },
        color = TuiMuted,
        fontSize = 10.sp,
      )
    }
    val controller = state.role == TuiControlRole.CONTROLLER
    Surface(
      modifier =
        Modifier.semantics {
          contentDescription =
            if (controller) {
              "Controller; terminal input and resize intents ready for transport"
            } else {
              "Observer; terminal input and resize intents require controller authority"
            }
        },
      color = if (controller) TuiAccent.copy(alpha = 0.16f) else TuiElevated,
      shape = RoundedCornerShape(999.dp),
      border = BorderStroke(1.dp, if (controller) TuiAccent.copy(alpha = 0.5f) else TuiBorder),
    ) {
      Text(
        if (controller) "CONTROLLER · INTENTS READY" else "OBSERVER · INPUT INERT",
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
        color = if (controller) TuiAccent else TuiMuted,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
      )
    }
  }
}

@Composable
private fun TerminalRows(
  state: TuiFrameState,
  layout: TuiSurfaceLayout,
  modifier: Modifier,
) {
  Surface(
    modifier = modifier.border(1.dp, TuiBorder, RoundedCornerShape(14.dp)),
    color = TuiSurfaceColor,
    shape = RoundedCornerShape(14.dp),
  ) {
    LazyColumn(Modifier.fillMaxSize().padding(vertical = 8.dp)) {
      items(state.rows, key = { it.row }) { row ->
        TerminalRow(
          row = row,
          cursor = state.cursor.takeIf { it.visible && it.row == row.row },
          minimumHeightDp = layout.minimumRowHeightDp,
        )
      }
    }
  }
}

@Composable
private fun TerminalRow(
  row: TuiRowModel,
  cursor: TuiCursorModel?,
  minimumHeightDp: Float,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = minimumHeightDp.dp)
        .background(if (cursor == null) Color.Transparent else TuiAccent.copy(alpha = 0.06f))
        .clearAndSetSemantics {
          contentDescription = "Terminal row ${row.row + 1}: ${row.plainText}"
        }.padding(horizontal = 10.dp, vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      if (cursor == null) " " else "▸",
      color = if (cursor == null) Color.Transparent else TuiAccent,
      fontFamily = FontFamily.Monospace,
      fontSize = 12.sp,
    )
    if (row.runs.isEmpty()) {
      Text(" ", fontFamily = FontFamily.Monospace, fontSize = 13.sp)
    } else {
      row.runs.forEach { run -> StyledRun(run) }
    }
  }
}

@Composable
private fun StyledRun(run: TuiStyledRunModel) {
  val baseForeground = tuiColor(run.style.foreground, TuiText)
  val baseBackground = tuiColor(run.style.background, Color.Transparent)
  val foreground = if (run.style.inverse) baseBackground.takeIf { it != Color.Transparent } ?: TuiCanvas else baseForeground
  val background = if (run.style.inverse) baseForeground else baseBackground
  Text(
    text = run.text,
    modifier = Modifier.background(background),
    color = if (run.style.dim) foreground.copy(alpha = 0.58f) else foreground,
    fontFamily = FontFamily.Monospace,
    fontSize = 13.sp,
    fontWeight = if (run.style.bold) FontWeight.Bold else FontWeight.Normal,
    fontStyle = if (run.style.italic) FontStyle.Italic else FontStyle.Normal,
    textDecoration = if (run.style.underline) TextDecoration.Underline else TextDecoration.None,
    maxLines = 1,
    overflow = TextOverflow.Clip,
  )
}

@Composable
private fun ReplayGapPanel(
  state: TuiFrameState,
  modifier: Modifier,
) {
  Box(
    modifier =
      modifier
        .semantics {
          contentDescription = "Terminal resynchronization required: ${state.gapReason ?: "unknown"}"
        }.padding(24.dp),
    contentAlignment = Alignment.Center,
  ) {
    Surface(
      color = TuiElevated,
      shape = RoundedCornerShape(18.dp),
      border = BorderStroke(1.dp, TuiYellow.copy(alpha = 0.55f)),
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Text("RESYNCHRONIZING", color = TuiYellow, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Text("Waiting for a fresh terminal snapshot", color = TuiText, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(state.gapReason ?: "replay gap", color = TuiMuted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
      }
    }
  }
}

private fun tuiColor(
  value: String?,
  fallback: Color,
): Color {
  if (value == null || !value.startsWith("#")) return fallback
  val hex = value.drop(1)
  return try {
    when (hex.length) {
      6 -> Color(0xFF000000L or hex.toLong(16))
      8 -> Color(hex.toLong(16))
      else -> fallback
    }
  } catch (_: NumberFormatException) {
    fallback
  }
}
