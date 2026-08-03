package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness

public enum class SessionSurfaceFormFactor {
  PHONE,
  TABLET,
}

public data class SessionSurfaceLayout(
  public val formFactor: SessionSurfaceFormFactor,
  public val fontScale: Float,
  public val minimumTouchTargetDp: Float,
  public val minimumRecordHeightDp: Float,
  public val inventoryWidthDp: Float,
  public val contentPaddingDp: Float,
) {
  init {
    require(fontScale in 0.85f..2f) { "session font scale is outside accessibility bounds" }
    require(minimumTouchTargetDp >= 48f) { "touch target is below the accessibility minimum" }
    require(minimumRecordHeightDp >= 56f) { "record height is below the accessibility minimum" }
    require(inventoryWidthDp >= 0f && contentPaddingDp >= 8f) { "session layout dimensions are invalid" }
  }

  public companion object {
    public fun phone(fontScale: Float = 1f): SessionSurfaceLayout =
      SessionSurfaceLayout(
        formFactor = SessionSurfaceFormFactor.PHONE,
        fontScale = fontScale,
        minimumTouchTargetDp = 48f,
        minimumRecordHeightDp = 64f,
        inventoryWidthDp = 0f,
        contentPaddingDp = 10f,
      )

    public fun tablet(fontScale: Float = 1f): SessionSurfaceLayout =
      SessionSurfaceLayout(
        formFactor = SessionSurfaceFormFactor.TABLET,
        fontScale = fontScale,
        minimumTouchTargetDp = 48f,
        minimumRecordHeightDp = 72f,
        inventoryWidthDp = 288f,
        contentPaddingDp = 16f,
      )
  }
}

public data class SessionScreenshotProfile(
  public val id: String,
  public val windowWidthPx: Int,
  public val windowHeightPx: Int,
  public val layout: SessionSurfaceLayout,
  public val freshness: CacheFreshness,
  public val observedAgeMillis: Long,
)

public object SessionScreenshotProfiles {
  public val all: List<SessionScreenshotProfile> =
    listOf(
      SessionScreenshotProfile(
        id = "phone",
        windowWidthPx = 430,
        windowHeightPx = 932,
        layout = SessionSurfaceLayout.phone(fontScale = 1f),
        freshness = CacheFreshness.RECONNECTING,
        observedAgeMillis = 2_000,
      ),
      SessionScreenshotProfile(
        id = "tablet",
        windowWidthPx = 1_280,
        windowHeightPx = 800,
        layout = SessionSurfaceLayout.tablet(fontScale = 1f),
        freshness = CacheFreshness.FRESH,
        observedAgeMillis = 0,
      ),
    )

  public fun profile(id: String): SessionScreenshotProfile =
    all.singleOrNull { it.id == id } ?: throw IllegalArgumentException("unknown session screenshot profile")
}
