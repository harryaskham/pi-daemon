package com.harryaskham.pidroid.workspace

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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

public data class PiDroidDailyDriverScreenshotProfile(
  public val id: String,
  public val title: String,
  public val widthDp: Int,
  public val heightDp: Int,
  public val windowWidthPx: Int,
  public val windowHeightPx: Int,
  public val fontScale: Float = 1f,
)

public object PiDroidDailyDriverScreenshotFixtures {
  public val all: List<PiDroidDailyDriverScreenshotProfile> =
    listOf(
      PiDroidDailyDriverScreenshotProfile(
        id = "phone",
        title = "Pi Droid daily driver · phone",
        widthDp = 412,
        heightDp = 892,
        windowWidthPx = 412,
        windowHeightPx = 892,
      ),
      PiDroidDailyDriverScreenshotProfile(
        id = "tablet",
        title = "Pi Droid daily driver · tablet",
        widthDp = 900,
        heightDp = 720,
        windowWidthPx = 900,
        windowHeightPx = 720,
      ),
      PiDroidDailyDriverScreenshotProfile(
        id = "wide",
        title = "Pi Droid daily driver · wide",
        widthDp = 1_280,
        heightDp = 800,
        windowWidthPx = 1_280,
        windowHeightPx = 800,
      ),
      PiDroidDailyDriverScreenshotProfile(
        id = "accessibility",
        title = "Pi Droid daily driver · large text",
        widthDp = 720,
        heightDp = 960,
        windowWidthPx = 900,
        windowHeightPx = 900,
        fontScale = 2f,
      ),
    )

  public fun profile(id: String): PiDroidDailyDriverScreenshotProfile =
    all.firstOrNull { it.id == id }
      ?: throw IllegalArgumentException("unknown daily-driver screenshot profile '$id'")
}

@Composable
public fun PiDroidDailyDriverShowcase(
  profile: PiDroidDailyDriverScreenshotProfile,
  modifier: Modifier = Modifier,
) {
  val layout = PiDroidDailyDriverAdaptivePolicy.resolve(profile.widthDp, profile.fontScale)
  val density = LocalDensity.current
  CompositionLocalProvider(LocalDensity provides Density(density.density, profile.fontScale)) {
    PiDroidUxTheme {
      Surface(
        modifier =
          modifier
            .fillMaxSize()
            .semantics {
              contentDescription = "Pi Droid daily driver, ${layout.windowClass.name.lowercase()} layout"
            },
        color = MaterialTheme.colorScheme.background,
      ) {
        Column(Modifier.fillMaxSize()) {
          DailyDriverTopBar(layout)
          if (layout.showPersistentSessionRail) {
            Row(
              modifier = Modifier.fillMaxSize().padding(layout.contentGutterDp.dp),
              horizontalArrangement = Arrangement.spacedBy(layout.contentGutterDp.dp),
            ) {
              SessionInventory(
                modifier = Modifier.width(layout.sessionRailWidthDp.dp).fillMaxHeight(),
                compact = false,
              )
              DailyDriverSession(
                modifier = Modifier.weight(1f).fillMaxHeight(),
                compact = false,
              )
              if (layout.showContextPane) {
                DailyDriverContextPane(Modifier.width(236.dp).fillMaxHeight())
              }
            }
          } else {
            Column(
              modifier = Modifier.fillMaxSize().padding(layout.contentGutterDp.dp),
              verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              SessionInventory(modifier = Modifier.fillMaxWidth(), compact = true)
              DailyDriverSession(modifier = Modifier.fillMaxWidth().weight(1f), compact = true)
            }
          }
        }
      }
    }
  }
}

@Composable
private fun DailyDriverTopBar(layout: PiDroidDailyDriverLayout) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = layout.contentGutterDp.dp, vertical = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Surface(
      modifier =
        Modifier
          .size(layout.minimumTouchTargetDp.dp)
          .semantics {
            contentDescription = "Open host management"
            role = Role.Button
          }.clickable { },
      color = MaterialTheme.colorScheme.surfaceVariant,
      shape = RoundedCornerShape(14.dp),
      border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Text("π", color = MaterialTheme.colorScheme.primary, fontSize = 22.sp, fontWeight = FontWeight.Black)
      }
    }
    Column(Modifier.weight(1f)) {
      Text(
        "PI DROID",
        color = MaterialTheme.colorScheme.primary,
        fontSize = 11.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 1.5.sp,
      )
      Text(
        "Studio host",
        color = MaterialTheme.colorScheme.onBackground,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    PiDroidStatusChip("Connected", PiDroidStatusTone.POSITIVE)
  }
}

@Composable
private fun SessionInventory(
  modifier: Modifier,
  compact: Boolean,
) {
  Surface(
    modifier = modifier,
    color = MaterialTheme.colorScheme.surface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.48f)),
  ) {
    Column(
      modifier = Modifier.padding(12.dp),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      PiDroidSectionTitle(
        eyebrow = "Sessions",
        title = if (compact) "Continue working" else "Session inventory",
        subtitle = "Sorted by recent activity",
      )
      Surface(
        modifier =
          Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics {
              contentDescription = "Search session inventory"
            },
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.62f),
        shape = RoundedCornerShape(14.dp),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 13.dp, vertical = 12.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text("⌕", color = MaterialTheme.colorScheme.primary)
          Spacer(Modifier.width(9.dp))
          Text("Search title, project, or path", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
        }
      }
      Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
      ) {
        PiDroidSessionFilter.entries.forEach { filter ->
          val selected = filter == PiDroidSessionFilter.ALL
          Surface(
            modifier =
              Modifier
                .heightIn(min = 48.dp)
                .semantics {
                  contentDescription =
                    if (selected) {
                      "${filter.label} sessions filter, selected"
                    } else {
                      "${filter.label} sessions filter"
                    }
                  role = Role.Button
                }.clickable { },
            color =
              if (selected) {
                MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
              } else {
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
              },
            shape = RoundedCornerShape(12.dp),
          ) {
            Box(Modifier.padding(horizontal = 13.dp, vertical = 11.dp)) {
              Text(
                filter.label,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
              )
            }
          }
        }
      }
      if (compact) {
        Row(
          modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          SessionInventoryCard("Daily driver polish", "pi-daemon · just now", selected = true, unread = true, Modifier.width(244.dp))
          SessionInventoryCard("Release notes", "docs · 14m ago", selected = false, unread = false, Modifier.width(220.dp))
        }
      } else {
        SessionInventoryCard("Daily driver polish", "pi-daemon · just now", selected = true, unread = true, Modifier.fillMaxWidth())
        SessionInventoryCard("Release notes", "docs · 14m ago", selected = false, unread = false, Modifier.fillMaxWidth())
        SessionInventoryCard("SDK migration", "android · yesterday", selected = false, unread = false, Modifier.fillMaxWidth())
      }
    }
  }
}

@Composable
private fun SessionInventoryCard(
  title: String,
  subtitle: String,
  selected: Boolean,
  unread: Boolean,
  modifier: Modifier,
) {
  Surface(
    modifier =
      modifier
        .heightIn(min = 56.dp)
        .semantics {
          contentDescription =
            buildString {
              append("Session $title, $subtitle")
              if (selected) append(", selected")
              if (unread) append(", unread")
            }
          role = Role.Button
        }.clickable { },
    color =
      if (selected) {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
      } else {
        Color.Transparent
      },
    shape = RoundedCornerShape(14.dp),
    border =
      BorderStroke(
        1.dp,
        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.56f) else MaterialTheme.colorScheme.outline.copy(alpha = 0.38f),
      ),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(Modifier.size(9.dp).clip(CircleShape).background(MaterialTheme.colorScheme.tertiary))
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(title, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, maxLines = 1)
      }
      if (unread) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
      }
    }
  }
}

@Composable
private fun DailyDriverSession(
  modifier: Modifier,
  compact: Boolean,
) {
  Surface(
    modifier = modifier,
    color = MaterialTheme.colorScheme.surface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.48f)),
  ) {
    Column(
      modifier = Modifier.padding(if (compact) 12.dp else 16.dp),
      verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(
            "Daily driver polish",
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
          )
          Text("~/src/pi-daemon", color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        }
        PiDroidStatusChip("Controller", PiDroidStatusTone.INFO)
      }
      PiDroidDestinationBar(selected = PiDroidDestination.TRANSCRIPT, onSelect = {})
      TranscriptBubble(
        speaker = "YOU",
        body = "Polish the Android daily-driver experience without changing the transport contract.",
        accent = MaterialTheme.colorScheme.primary,
      )
      TranscriptBubble(
        speaker = "PI",
        body = "The adaptive session inventory and secure host flow are ready for focused verification.",
        accent = MaterialTheme.colorScheme.tertiary,
      )
      Spacer(Modifier.weight(1f))
      Surface(
        modifier =
          Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .semantics {
              contentDescription = "Controller composer. Prompt text is never restored after process recreation."
            },
        color = MaterialTheme.colorScheme.background.copy(alpha = 0.55f),
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 13.dp, vertical = 11.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text("Message Pi…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
          Surface(
            modifier =
              Modifier
                .size(48.dp)
                .semantics {
                  contentDescription = "Send prompt"
                  role = Role.Button
                }.clickable { },
            color = MaterialTheme.colorScheme.primary,
            shape = RoundedCornerShape(14.dp),
          ) {
            Box(contentAlignment = Alignment.Center) {
              Text("↑", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Black)
            }
          }
        }
      }
    }
  }
}

@Composable
private fun TranscriptBubble(
  speaker: String,
  body: String,
  accent: Color,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(accent))
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(speaker, color = accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
      Text(body, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
    }
  }
}

@Composable
private fun DailyDriverContextPane(modifier: Modifier) {
  Surface(
    modifier = modifier,
    color = MaterialTheme.colorScheme.surface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.48f)),
  ) {
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      PiDroidSectionTitle(
        eyebrow = "Safety",
        title = "Live context",
        subtitle = "Bounded control state",
      )
      ContextMetric("Connection", "Connected")
      ContextMetric("Role", "Controller")
      ContextMetric("Receipt", "Accepted")
      Surface(
        color = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.1f),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.tertiary.copy(alpha = 0.35f)),
      ) {
        Text(
          "Reconnect is explicit. Accepted and indeterminate actions are never replayed blindly.",
          modifier = Modifier.padding(12.dp),
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          fontSize = 12.sp,
        )
      }
      Spacer(Modifier.weight(1f))
      PiDroidStatusChip("No secrets retained", PiDroidStatusTone.MUTED)
    }
  }
}

@Composable
private fun ContextMetric(
  label: String,
  value: String,
) {
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
    Text(value, color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
  }
}
