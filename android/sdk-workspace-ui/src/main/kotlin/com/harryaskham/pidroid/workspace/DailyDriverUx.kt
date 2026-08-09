package com.harryaskham.pidroid.workspace

import java.net.URI
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

public enum class PiDroidWindowClass {
  PHONE,
  TABLET,
  WIDE,
}

public data class PiDroidDailyDriverLayout(
  public val windowClass: PiDroidWindowClass,
  public val minimumTouchTargetDp: Float,
  public val contentGutterDp: Float,
  public val sessionRailWidthDp: Float,
  public val showPersistentSessionRail: Boolean,
  public val showContextPane: Boolean,
)

public object PiDroidDailyDriverAdaptivePolicy {
  public fun resolve(
    widthDp: Int,
    fontScale: Float = 1f,
  ): PiDroidDailyDriverLayout {
    require(widthDp > 0) { "widthDp must be positive" }
    require(fontScale > 0f) { "fontScale must be positive" }
    val effectiveWidth = widthDp / fontScale.coerceAtLeast(1f)
    val windowClass =
      when {
        effectiveWidth < 600f -> PiDroidWindowClass.PHONE
        effectiveWidth < 1_000f -> PiDroidWindowClass.TABLET
        else -> PiDroidWindowClass.WIDE
      }
    return when (windowClass) {
      PiDroidWindowClass.PHONE -> {
        PiDroidDailyDriverLayout(
          windowClass = windowClass,
          minimumTouchTargetDp = 48f,
          contentGutterDp = 12f,
          sessionRailWidthDp = 0f,
          showPersistentSessionRail = false,
          showContextPane = false,
        )
      }

      PiDroidWindowClass.TABLET -> {
        PiDroidDailyDriverLayout(
          windowClass = windowClass,
          minimumTouchTargetDp = 48f,
          contentGutterDp = 16f,
          sessionRailWidthDp = 300f,
          showPersistentSessionRail = true,
          showContextPane = false,
        )
      }

      PiDroidWindowClass.WIDE -> {
        PiDroidDailyDriverLayout(
          windowClass = windowClass,
          minimumTouchTargetDp = 48f,
          contentGutterDp = 20f,
          sessionRailWidthDp = 324f,
          showPersistentSessionRail = true,
          showContextPane = true,
        )
      }
    }
  }
}

public enum class PiDroidDestination(
  public val label: String,
) {
  TRANSCRIPT("Transcript"),
  TREE("Tree"),
  TERMINAL("Terminal"),
  EXTENSIONS("Extensions"),
}

public enum class PiDroidSessionFilter(
  public val label: String,
) {
  ALL("All"),
  ACTIVE("Active"),
  UNREAD("Unread"),
}

public data class PiDroidSessionSummary(
  public val id: String,
  public val title: String,
  public val project: String?,
  public val cwd: String?,
  public val state: String,
  public val unread: Boolean,
  public val activityAt: String?,
)

public object PiDroidSessionInventory {
  public fun filter(
    sessions: List<PiDroidSessionSummary>,
    query: String,
    filter: PiDroidSessionFilter,
  ): List<PiDroidSessionSummary> {
    val needle = query.trim().lowercase(Locale.ROOT)
    return sessions
      .asSequence()
      .filter { session ->
        needle.isEmpty() ||
          listOfNotNull(session.title, session.project, session.cwd, session.state)
            .any { it.lowercase(Locale.ROOT).contains(needle) }
      }.filter { session ->
        when (filter) {
          PiDroidSessionFilter.ALL -> {
            true
          }

          PiDroidSessionFilter.ACTIVE -> {
            session.state.lowercase(Locale.ROOT) in
              setOf("active", "busy", "connected", "queued", "running", "working")
          }

          PiDroidSessionFilter.UNREAD -> {
            session.unread
          }
        }
      }.sortedWith(
        compareByDescending<PiDroidSessionSummary> { parseInstantOrMinimum(it.activityAt) }
          .thenBy { it.title.lowercase(Locale.ROOT) }
          .thenBy { it.id },
      ).toList()
  }

  private fun parseInstantOrMinimum(value: String?): Instant = runCatching { value?.let(Instant::parse) }.getOrNull() ?: Instant.MIN
}

public enum class PiDroidEndpointSecurity {
  SECURE,
  LOOPBACK_HTTP,
  REMOTE_HTTP_REQUIRES_ACKNOWLEDGEMENT,
  INVALID,
  UNSUPPORTED_SCHEME,
}

public data class PiDroidEndpointAssessment(
  public val security: PiDroidEndpointSecurity,
  public val headline: String,
  public val guidance: String,
  public val canConnect: Boolean,
  public val requiresCleartextAcknowledgement: Boolean,
)

public object PiDroidEndpointPolicy {
  public fun assess(rawEndpoint: String): PiDroidEndpointAssessment {
    val endpoint = rawEndpoint.trim()
    if (endpoint.isEmpty()) {
      return invalid("Enter the Pi Daemon endpoint.")
    }
    val uri =
      runCatching { URI(endpoint) }.getOrNull()
        ?: return invalid("Use a complete https:// or http:// endpoint.")
    if (uri.host.isNullOrBlank() || uri.userInfo != null) {
      return invalid("Use a host endpoint without embedded credentials.")
    }
    return when (uri.scheme?.lowercase(Locale.ROOT)) {
      "https" -> {
        PiDroidEndpointAssessment(
          security = PiDroidEndpointSecurity.SECURE,
          headline = "Encrypted connection",
          guidance = "TLS protects the bearer and session traffic in transit.",
          canConnect = true,
          requiresCleartextAcknowledgement = false,
        )
      }

      "http" -> {
        if (uri.host.isLoopbackHost()) {
          PiDroidEndpointAssessment(
            security = PiDroidEndpointSecurity.LOOPBACK_HTTP,
            headline = "Loopback development connection",
            guidance = "Cleartext is limited to this device. Prefer HTTPS for another host.",
            canConnect = true,
            requiresCleartextAcknowledgement = false,
          )
        } else {
          PiDroidEndpointAssessment(
            security = PiDroidEndpointSecurity.REMOTE_HTTP_REQUIRES_ACKNOWLEDGEMENT,
            headline = "Remote connection is not encrypted",
            guidance = "The bearer and session traffic can be observed in transit. Continue only on a trusted private network.",
            canConnect = true,
            requiresCleartextAcknowledgement = true,
          )
        }
      }

      else -> {
        PiDroidEndpointAssessment(
          security = PiDroidEndpointSecurity.UNSUPPORTED_SCHEME,
          headline = "Unsupported endpoint scheme",
          guidance = "Pi Droid accepts only HTTPS, or explicitly acknowledged HTTP.",
          canConnect = false,
          requiresCleartextAcknowledgement = false,
        )
      }
    }
  }

  private fun invalid(guidance: String): PiDroidEndpointAssessment =
    PiDroidEndpointAssessment(
      security = PiDroidEndpointSecurity.INVALID,
      headline = "Endpoint needs attention",
      guidance = guidance,
      canConnect = false,
      requiresCleartextAcknowledgement = false,
    )

  private fun String.isLoopbackHost(): Boolean =
    lowercase(Locale.ROOT) in setOf("localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1")
}

public object PiDroidRelativeActivity {
  private val absoluteFormatter =
    DateTimeFormatter
      .ofPattern("MMM d", Locale.ENGLISH)
      .withZone(ZoneOffset.UTC)

  public fun label(
    activityAt: String?,
    now: Instant,
  ): String {
    val activity = runCatching { activityAt?.let(Instant::parse) }.getOrNull() ?: return "Activity unknown"
    val elapsed = Duration.between(activity, now).coerceAtLeast(Duration.ZERO)
    return when {
      elapsed < Duration.ofMinutes(1) -> "Just now"
      elapsed < Duration.ofHours(1) -> "${elapsed.toMinutes()}m ago"
      elapsed < Duration.ofDays(1) -> "${elapsed.toHours()}h ago"
      elapsed < Duration.ofDays(7) -> "${elapsed.toDays()}d ago"
      else -> absoluteFormatter.format(activity)
    }
  }
}
