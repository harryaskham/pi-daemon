package com.harryaskham.pidroid.workspace

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

public object PiDroidColorSchemes {
  public val Dark: ColorScheme =
    darkColorScheme(
      primary = Color(0xFF88CFE0),
      onPrimary = Color(0xFF071318),
      secondary = Color(0xFFBEA6E2),
      tertiary = Color(0xFFA6D7A0),
      background = Color(0xFF0B1018),
      onBackground = Color(0xFFE7EDF6),
      surface = Color(0xFF111A27),
      onSurface = Color(0xFFE7EDF6),
      surfaceVariant = Color(0xFF192537),
      onSurfaceVariant = Color(0xFFA9B6C9),
      outline = Color(0xFF394960),
      error = Color(0xFFE99AA1),
      onError = Color(0xFF2B060B),
    )

  public val Light: ColorScheme =
    lightColorScheme(
      primary = Color(0xFF08677B),
      onPrimary = Color.White,
      secondary = Color(0xFF65528B),
      tertiary = Color(0xFF356A37),
      background = Color(0xFFF5F8FC),
      onBackground = Color(0xFF16202D),
      surface = Color(0xFFFFFFFF),
      onSurface = Color(0xFF16202D),
      surfaceVariant = Color(0xFFE7EEF6),
      onSurfaceVariant = Color(0xFF48576A),
      outline = Color(0xFF728197),
      error = Color(0xFFBA1A1A),
      onError = Color.White,
    )
}

@Composable
public fun PiDroidUxTheme(
  colorScheme: ColorScheme = PiDroidColorSchemes.Dark,
  content: @Composable () -> Unit,
) {
  MaterialTheme(colorScheme = colorScheme, content = content)
}

public enum class PiDroidStatusTone {
  INFO,
  POSITIVE,
  WARNING,
  ERROR,
  MUTED,
}

@Composable
public fun PiDroidStatusChip(
  label: String,
  tone: PiDroidStatusTone,
  modifier: Modifier = Modifier,
) {
  val colors = MaterialTheme.colorScheme
  val color =
    when (tone) {
      PiDroidStatusTone.INFO -> colors.primary
      PiDroidStatusTone.POSITIVE -> colors.tertiary
      PiDroidStatusTone.WARNING -> Color(0xFFE6C67B)
      PiDroidStatusTone.ERROR -> colors.error
      PiDroidStatusTone.MUTED -> colors.onSurfaceVariant
    }
  Surface(
    modifier =
      modifier.semantics {
        contentDescription = "Status: $label"
      },
    color = color.copy(alpha = 0.13f),
    shape = RoundedCornerShape(999.dp),
    border = BorderStroke(1.dp, color.copy(alpha = 0.42f)),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
      horizontalArrangement = Arrangement.spacedBy(7.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(Modifier.size(7.dp).clip(CircleShape).background(color))
      Text(
        text = label.uppercase(),
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.7.sp,
        maxLines = 1,
      )
    }
  }
}

@Composable
public fun PiDroidSectionTitle(
  title: String,
  subtitle: String,
  modifier: Modifier = Modifier,
  eyebrow: String? = null,
) {
  Column(
    modifier = modifier.semantics(mergeDescendants = true) { heading() },
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    if (eyebrow != null) {
      Text(
        text = eyebrow.uppercase(),
        color = MaterialTheme.colorScheme.primary,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.4.sp,
      )
    }
    Text(
      text = title,
      color = MaterialTheme.colorScheme.onBackground,
      style = MaterialTheme.typography.headlineSmall,
      fontWeight = FontWeight.Bold,
    )
    Text(
      text = subtitle,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.bodyMedium,
    )
  }
}

@Composable
public fun PiDroidDestinationBar(
  selected: PiDroidDestination,
  onSelect: (PiDroidDestination) -> Unit,
  modifier: Modifier = Modifier,
) {
  Row(
    modifier = modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    PiDroidDestination.entries.forEach { destination ->
      val isSelected = destination == selected
      Surface(
        modifier =
          Modifier
            .heightIn(min = 48.dp)
            .semantics {
              contentDescription =
                if (isSelected) {
                  "${destination.label} destination, selected"
                } else {
                  "${destination.label} destination"
                }
              this.selected = isSelected
              role = Role.Tab
            }.selectable(
              selected = isSelected,
              role = Role.Tab,
              onClick = { onSelect(destination) },
            ),
        color =
          if (isSelected) {
            MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
          } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.58f)
          },
        shape = RoundedCornerShape(14.dp),
        border =
          BorderStroke(
            1.dp,
            if (isSelected) {
              MaterialTheme.colorScheme.primary.copy(alpha = 0.62f)
            } else {
              MaterialTheme.colorScheme.outline.copy(alpha = 0.52f)
            },
          ),
      ) {
        Box(modifier = Modifier.padding(horizontal = 15.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
          Text(
            destination.label,
            color = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
          )
        }
      }
    }
  }
}

@Composable
public fun PiDroidLoadingState(
  label: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier =
      modifier.fillMaxWidth().semantics {
        contentDescription = "Loading: $label"
      },
    color = MaterialTheme.colorScheme.surface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
  ) {
    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(label, color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)
      SkeletonBar(0.82f)
      SkeletonBar(1f)
      SkeletonBar(0.64f)
    }
  }
}

@Composable
private fun SkeletonBar(fraction: Float) {
  Spacer(
    Modifier
      .fillMaxWidth(fraction)
      .height(12.dp)
      .clip(RoundedCornerShape(999.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant),
  )
}

@Composable
public fun PiDroidEmptyState(
  title: String,
  body: String,
  modifier: Modifier = Modifier,
  actionLabel: String? = null,
  onAction: (() -> Unit)? = null,
) {
  StateCard(
    title = title,
    body = body,
    contentDescription = "Empty state: $title. $body",
    modifier = modifier,
    actionLabel = actionLabel,
    onAction = onAction,
  )
}

@Composable
public fun PiDroidErrorState(
  title: String,
  body: String,
  retryLabel: String,
  onRetry: () -> Unit,
  modifier: Modifier = Modifier,
) {
  StateCard(
    title = title,
    body = body,
    contentDescription = "Error: $title. $body",
    modifier = modifier,
    actionLabel = retryLabel,
    onAction = onRetry,
    borderColor = MaterialTheme.colorScheme.error.copy(alpha = 0.56f),
  )
}

@Composable
private fun StateCard(
  title: String,
  body: String,
  contentDescription: String,
  modifier: Modifier,
  actionLabel: String?,
  onAction: (() -> Unit)?,
  borderColor: Color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
) {
  Surface(
    modifier =
      modifier.fillMaxWidth().semantics {
        this.contentDescription = contentDescription
      },
    color = MaterialTheme.colorScheme.surface,
    shape = RoundedCornerShape(20.dp),
    border = BorderStroke(1.dp, borderColor),
  ) {
    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
      Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
      if (actionLabel != null && onAction != null) {
        Spacer(Modifier.height(2.dp))
        Button(
          modifier = Modifier.heightIn(min = 48.dp),
          onClick = onAction,
        ) {
          Text(actionLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

@Composable
public fun PiDroidEndpointSecurityCard(
  assessment: PiDroidEndpointAssessment,
  acknowledged: Boolean,
  onAcknowledgedChange: (Boolean) -> Unit,
  modifier: Modifier = Modifier,
) {
  val tone =
    when (assessment.security) {
      PiDroidEndpointSecurity.SECURE,
      PiDroidEndpointSecurity.LOOPBACK_HTTP,
      -> PiDroidStatusTone.POSITIVE

      PiDroidEndpointSecurity.REMOTE_HTTP_REQUIRES_ACKNOWLEDGEMENT -> PiDroidStatusTone.WARNING

      PiDroidEndpointSecurity.INVALID,
      PiDroidEndpointSecurity.UNSUPPORTED_SCHEME,
      -> PiDroidStatusTone.ERROR
    }
  Surface(
    modifier = modifier.fillMaxWidth(),
    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.58f),
    shape = RoundedCornerShape(16.dp),
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
  ) {
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      PiDroidStatusChip(assessment.headline, tone)
      Text(assessment.guidance, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
      if (assessment.requiresCleartextAcknowledgement) {
        Surface(
          modifier =
            Modifier
              .fillMaxWidth()
              .heightIn(min = 48.dp)
              .semantics {
                contentDescription =
                  if (acknowledged) {
                    "Remote cleartext risk acknowledged"
                  } else {
                    "Acknowledge remote cleartext risk"
                  }
                role = Role.Checkbox
              }.toggleable(
                value = acknowledged,
                role = Role.Checkbox,
                onValueChange = onAcknowledgedChange,
              ),
          color = MaterialTheme.colorScheme.background.copy(alpha = 0.42f),
          shape = RoundedCornerShape(12.dp),
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 13.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(if (acknowledged) "✓" else "○", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(10.dp))
            Text(
              "I understand this remote HTTP connection is not encrypted",
              color = MaterialTheme.colorScheme.onSurface,
              style = MaterialTheme.typography.bodySmall,
            )
          }
        }
      }
    }
  }
}
