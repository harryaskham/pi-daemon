package com.harryaskham.pidroid.sessionui

public const val TUI_MAX_ROWS: Int = 200
public const val TUI_MAX_COLUMNS: Int = 320

public data class TuiSessionIdentity(
  public val hostInstanceId: String,
  public val sessionId: String,
  public val generation: Int,
) {
  init {
    require(hostInstanceId.isNotBlank() && hostInstanceId.length <= 256) { "TUI host identity is invalid" }
    require(sessionId.isNotBlank() && sessionId.length <= 256) { "TUI session identity is invalid" }
    require(generation >= 0) { "TUI generation is invalid" }
  }
}

public data class TuiDimensionsModel(
  public val rows: Int,
  public val columns: Int,
) {
  init {
    require(rows in 1..TUI_MAX_ROWS) { "TUI rows exceed the negotiated safety bound" }
    require(columns in 1..TUI_MAX_COLUMNS) { "TUI columns exceed the negotiated safety bound" }
  }
}

public enum class TuiCursorShape {
  BLOCK,
  BAR,
  UNDERLINE,
}

public data class TuiCursorModel(
  public val row: Int,
  public val column: Int,
  public val visible: Boolean,
  public val shape: TuiCursorShape,
)

public data class TuiStyleModel(
  public val foreground: String? = null,
  public val background: String? = null,
  public val bold: Boolean = false,
  public val dim: Boolean = false,
  public val italic: Boolean = false,
  public val underline: Boolean = false,
  public val inverse: Boolean = false,
)

public class TuiStyledRunModel(
  public val text: String,
  public val style: TuiStyleModel,
) {
  override fun toString(): String = "TuiStyledRunModel(chars=${text.length}, style=$style, content=[REDACTED])"
}

public class TuiRowModel(
  public val row: Int,
  public val runs: List<TuiStyledRunModel>,
) {
  public val plainText: String = runs.joinToString(separator = "") { it.text }

  override fun toString(): String = "TuiRowModel(row=$row, runs=${runs.size}, chars=${plainText.length}, content=[REDACTED])"

  public companion object {
    public fun empty(row: Int): TuiRowModel = TuiRowModel(row, emptyList())
  }
}

public enum class TuiControlRole {
  OBSERVER,
  CONTROLLER,
}

public enum class TuiFramePhase {
  LIVE,
  REPLAY_GAP,
}

public data class TuiFrameState(
  public val identity: TuiSessionIdentity,
  public val dimensions: TuiDimensionsModel,
  public val rows: List<TuiRowModel>,
  public val cursor: TuiCursorModel,
  public val title: String?,
  public val highWaterCursor: String,
  public val sequence: Long,
  public val phase: TuiFramePhase,
  public val role: TuiControlRole,
  public val gapReason: String? = null,
) {
  init {
    require(highWaterCursor.isNotBlank() && highWaterCursor.length <= 1_024) { "TUI high-water cursor is invalid" }
    require(sequence >= 0) { "TUI sequence is invalid" }
    require(title == null || (title.length <= 256 && title.none { it == '\u0000' || it == '\n' || it == '\r' })) {
      "TUI title is invalid"
    }
    if (phase == TuiFramePhase.LIVE) {
      require(rows.size == dimensions.rows && rows.indices.all { rows[it].row == it }) {
        "live TUI rows must be normalized to the negotiated dimensions"
      }
    } else {
      require(rows.isEmpty()) { "replay-gap state must discard stale terminal rows" }
    }
  }

  public val canSendIntents: Boolean
    get() = phase == TuiFramePhase.LIVE && role == TuiControlRole.CONTROLLER

  override fun toString(): String =
    "TuiFrameState(identity=$identity, dimensions=$dimensions, rows=${rows.size}, cursor=$cursor, title=${title?.length}, highWaterCursor=[OPAQUE], sequence=$sequence, phase=$phase, role=$role, gapReason=$gapReason, content=[REDACTED])"
}

public data class TuiDeltaModel(
  public val identity: TuiSessionIdentity,
  public val cursor: String,
  public val sequence: Long,
  public val dimensions: TuiDimensionsModel,
  public val changedRows: List<TuiRowModel>,
  public val cursorState: TuiCursorModel,
  public val title: String?,
)

public data class TuiReplayGapModel(
  public val identity: TuiSessionIdentity,
  public val reason: String,
  public val requestedCursor: String?,
  public val highWaterCursor: String,
  public val oldestAvailableCursor: String?,
  public val snapshotFollows: Boolean,
)

public enum class TuiModifier {
  CTRL,
  ALT,
  SHIFT,
  META,
}

public sealed interface TuiInputModel {
  public data class Key(
    public val key: String,
    public val modifiers: Set<TuiModifier> = emptySet(),
  ) : TuiInputModel {
    init {
      require(key.isNotBlank() && key.length <= 64 && key.none { it == '\u0000' || it == '\n' || it == '\r' }) {
        "TUI key input is invalid"
      }
    }
  }

  public data class Text(
    public val text: String,
  ) : TuiInputModel {
    init {
      require(text.isNotEmpty() && text.length <= 65_536 && '\u0000' !in text) { "TUI text input is invalid" }
    }
  }

  public data class Paste(
    public val text: String,
  ) : TuiInputModel {
    init {
      require(text.isNotEmpty() && text.length <= 65_536 && '\u0000' !in text) { "TUI paste input is invalid" }
    }
  }
}

public sealed interface TuiInteractionIntent {
  public data class Input(
    public val input: TuiInputModel,
  ) : TuiInteractionIntent

  public data class Resize(
    public val dimensions: TuiDimensionsModel,
  ) : TuiInteractionIntent
}

public enum class TuiIntentDisposition {
  READY,
  REQUIRES_CONTROLLER,
  RESYNC_REQUIRED,
}

public data class TuiIntentDecision(
  public val intent: TuiInteractionIntent?,
  public val disposition: TuiIntentDisposition,
) {
  public val isDispatchable: Boolean
    get() = disposition == TuiIntentDisposition.READY && intent != null
}

public enum class TuiSurfaceFormFactor {
  PHONE,
  TABLET,
}

public data class TuiSurfaceLayout(
  public val formFactor: TuiSurfaceFormFactor,
  public val fontScale: Float,
  public val minimumTouchTargetDp: Float,
  public val minimumRowHeightDp: Float,
  public val terminalPaddingDp: Float,
) {
  init {
    require(fontScale in 0.85f..2f) { "TUI font scale is outside accessibility bounds" }
    require(minimumTouchTargetDp >= 48f) { "TUI touch target is below the accessibility minimum" }
    require(minimumRowHeightDp >= 20f) { "TUI row height is invalid" }
    require(terminalPaddingDp >= 8f) { "TUI terminal padding is invalid" }
  }

  public companion object {
    public fun phone(fontScale: Float = 1f): TuiSurfaceLayout = TuiSurfaceLayout(TuiSurfaceFormFactor.PHONE, fontScale, 48f, 22f, 10f)

    public fun tablet(fontScale: Float = 1f): TuiSurfaceLayout = TuiSurfaceLayout(TuiSurfaceFormFactor.TABLET, fontScale, 48f, 24f, 18f)
  }
}

public data class TuiScreenshotProfile(
  public val id: String,
  public val windowWidthPx: Int,
  public val windowHeightPx: Int,
  public val layout: TuiSurfaceLayout,
  public val role: TuiControlRole,
)

public object TuiScreenshotProfiles {
  public val all: List<TuiScreenshotProfile> =
    listOf(
      TuiScreenshotProfile("phone", 430, 932, TuiSurfaceLayout.phone(), TuiControlRole.OBSERVER),
      TuiScreenshotProfile("tablet", 1_280, 800, TuiSurfaceLayout.tablet(), TuiControlRole.CONTROLLER),
    )
}
