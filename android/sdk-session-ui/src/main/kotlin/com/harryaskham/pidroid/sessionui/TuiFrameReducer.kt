package com.harryaskham.pidroid.sessionui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

public class TuiFrameException(
  public val code: String,
  message: String,
) : IllegalArgumentException(message)

public object TuiFrameDecoder {
  private const val MAX_FRAME_CHARS: Int = 1_048_576
  private const val MAX_RUNS_PER_ROW: Int = TUI_MAX_COLUMNS
  private const val MAX_RUN_TEXT_CHARS: Int = 2_048
  private val json: Json = Json

  public fun decodeSnapshot(
    text: String,
    role: TuiControlRole,
  ): TuiFrameState {
    val root = parseObject(text, "snapshot")
    val identity = decodeIdentity(root.requiredObject("identity"))
    val dimensions = decodeDimensions(root.requiredObject("dimensions"))
    val rows = decodeRows(root.requiredArray("rows"), dimensions, requireComplete = false)
    val cursor = decodeCursor(root.requiredObject("cursor"), dimensions)
    return TuiFrameState(
      identity = identity,
      dimensions = dimensions,
      rows = normalizeRows(rows, dimensions),
      cursor = cursor,
      title = root.optionalBoundedString("title", 256),
      highWaterCursor = root.requiredBoundedString("highWaterCursor", 1_024),
      sequence = 0,
      phase = TuiFramePhase.LIVE,
      role = role,
    )
  }

  public fun decodeDelta(text: String): TuiDeltaModel {
    val root = parseObject(text, "delta")
    val delta = (root["delta"] as? JsonObject) ?: root
    if (delta.optionalBoundedString("kind", 64) != "tui_delta") {
      throw TuiFrameException("invalid_delta", "TUI delta kind is invalid")
    }
    val dimensions = decodeDimensions(delta.requiredObject("dimensions"))
    return TuiDeltaModel(
      identity = decodeIdentity(delta.requiredObject("identity")),
      cursor = delta.requiredBoundedString("cursor", 1_024),
      sequence = delta.requiredPositiveLong("sequence"),
      dimensions = dimensions,
      changedRows = decodeRows(delta.requiredArray("changedRows"), dimensions, requireComplete = false),
      cursorState = decodeCursor(delta.requiredObject("cursorState"), dimensions),
      title = delta.optionalBoundedString("title", 256),
    )
  }

  public fun decodeReplayGap(text: String): TuiReplayGapModel {
    val root = parseObject(text, "replay gap")
    val gap = (root["gap"] as? JsonObject) ?: root
    if (gap.optionalBoundedString("kind", 64) != "replay_gap") {
      throw TuiFrameException("invalid_replay_gap", "TUI replay gap kind is invalid")
    }
    return TuiReplayGapModel(
      identity = decodeIdentity(gap.requiredObject("identity")),
      reason = gap.requiredBoundedString("reason", 128),
      requestedCursor = gap.optionalBoundedString("requestedCursor", 1_024),
      highWaterCursor = gap.requiredBoundedString("highWaterCursor", 1_024),
      oldestAvailableCursor = gap.optionalBoundedString("oldestAvailableCursor", 1_024),
      snapshotFollows = gap.requiredBoolean("snapshotFollows"),
    )
  }

  private fun parseObject(
    text: String,
    label: String,
  ): JsonObject {
    if (text.length > MAX_FRAME_CHARS) {
      throw TuiFrameException("frame_too_large", "TUI $label exceeds the frame bound")
    }
    return try {
      json.parseToJsonElement(text) as? JsonObject
    } catch (_: Exception) {
      null
    } ?: throw TuiFrameException("invalid_json", "TUI $label is not a JSON object")
  }

  private fun decodeIdentity(value: JsonObject): TuiSessionIdentity =
    TuiSessionIdentity(
      hostInstanceId = value.requiredBoundedString("hostInstanceId", 256),
      sessionId = value.requiredBoundedString("sessionId", 256),
      generation = value.requiredNonNegativeInt("generation"),
    )

  private fun decodeDimensions(value: JsonObject): TuiDimensionsModel =
    try {
      TuiDimensionsModel(
        rows = value.requiredPositiveInt("rows"),
        columns = value.requiredPositiveInt("columns"),
      )
    } catch (_: IllegalArgumentException) {
      throw TuiFrameException("dimensions_out_of_bounds", "TUI dimensions exceed the safety bound")
    }

  private fun decodeRows(
    value: JsonArray,
    dimensions: TuiDimensionsModel,
    requireComplete: Boolean,
  ): List<TuiRowModel> {
    if (value.size > if (requireComplete) dimensions.rows else TUI_MAX_ROWS) {
      throw TuiFrameException("rows_out_of_bounds", "TUI row collection exceeds the safety bound")
    }
    val seen = mutableSetOf<Int>()
    return value.map { element ->
      val rowObject = element as? JsonObject ?: throw TuiFrameException("invalid_row", "TUI row is invalid")
      val row = rowObject.requiredNonNegativeInt("row")
      if (row !in 0 until dimensions.rows || !seen.add(row)) {
        throw TuiFrameException("row_out_of_bounds", "TUI row is outside dimensions or duplicated")
      }
      val runs = rowObject.requiredArray("runs")
      if (runs.size > MAX_RUNS_PER_ROW) {
        throw TuiFrameException("row_too_large", "TUI row contains too many styled runs")
      }
      val decoded = runs.map(::decodeRun)
      if (decoded.sumOf { it.text.length } > dimensions.columns * 4) {
        throw TuiFrameException("row_too_large", "TUI row text exceeds the negotiated columns")
      }
      TuiRowModel(row, decoded)
    }
  }

  private fun decodeRun(element: JsonElement): TuiStyledRunModel {
    val value = element as? JsonObject ?: throw TuiFrameException("invalid_run", "TUI styled run is invalid")
    val text = value.requiredBoundedString("text", MAX_RUN_TEXT_CHARS, allowEmpty = true)
    if (text.any { it == '\u0000' || it == '\n' || it == '\r' }) {
      throw TuiFrameException("invalid_run", "TUI styled run contains a control character")
    }
    val style = value["style"] as? JsonObject
    return TuiStyledRunModel(
      text = text,
      style =
        TuiStyleModel(
          foreground = style?.optionalColor("foreground"),
          background = style?.optionalColor("background"),
          bold = style?.optionalBoolean("bold") ?: false,
          dim = style?.optionalBoolean("dim") ?: false,
          italic = style?.optionalBoolean("italic") ?: false,
          underline = style?.optionalBoolean("underline") ?: false,
          inverse = style?.optionalBoolean("inverse") ?: false,
        ),
    )
  }

  private fun decodeCursor(
    value: JsonObject,
    dimensions: TuiDimensionsModel,
  ): TuiCursorModel {
    val row = value.requiredNonNegativeInt("row")
    val column = value.requiredNonNegativeInt("column")
    if (row !in 0 until dimensions.rows || column !in 0 until dimensions.columns) {
      throw TuiFrameException("cursor_out_of_bounds", "TUI cursor is outside dimensions")
    }
    val shape =
      when (value.optionalBoundedString("shape", 32) ?: "block") {
        "block" -> TuiCursorShape.BLOCK
        "bar" -> TuiCursorShape.BAR
        "underline" -> TuiCursorShape.UNDERLINE
        else -> throw TuiFrameException("invalid_cursor", "TUI cursor shape is invalid")
      }
    return TuiCursorModel(row, column, value.requiredBoolean("visible"), shape)
  }

  private fun normalizeRows(
    rows: List<TuiRowModel>,
    dimensions: TuiDimensionsModel,
  ): List<TuiRowModel> {
    val byRow = rows.associateBy { it.row }
    return List(dimensions.rows) { row -> byRow[row] ?: TuiRowModel.empty(row) }
  }
}

public object TuiFrameReducer {
  public fun applySnapshot(
    previous: TuiFrameState,
    snapshot: TuiFrameState,
  ): TuiFrameState {
    requireIdentity(previous.identity, snapshot.identity)
    return snapshot.copy(role = previous.role)
  }

  public fun applyDelta(
    state: TuiFrameState,
    delta: TuiDeltaModel,
  ): TuiFrameState {
    requireIdentity(state.identity, delta.identity)
    if (state.phase == TuiFramePhase.REPLAY_GAP) return state
    if (state.sequence > 0 && delta.sequence <= state.sequence) return state
    if (state.sequence > 0 && delta.sequence != state.sequence + 1) {
      return requireResync(state, "sequence-gap", delta.cursor)
    }

    val resized =
      List(delta.dimensions.rows) { row ->
        state.rows.getOrNull(row)?.takeIf { it.row == row } ?: TuiRowModel.empty(row)
      }.toMutableList()
    for (changed in delta.changedRows) resized[changed.row] = changed
    return state.copy(
      dimensions = delta.dimensions,
      rows = resized,
      cursor = delta.cursorState,
      title = delta.title,
      highWaterCursor = delta.cursor,
      sequence = delta.sequence,
      phase = TuiFramePhase.LIVE,
      gapReason = null,
    )
  }

  public fun applyReplayGap(
    state: TuiFrameState,
    gap: TuiReplayGapModel,
  ): TuiFrameState {
    requireIdentity(state.identity, gap.identity)
    return requireResync(state, gap.reason, gap.highWaterCursor)
  }

  private fun requireResync(
    state: TuiFrameState,
    reason: String,
    highWaterCursor: String,
  ): TuiFrameState =
    state.copy(
      rows = emptyList(),
      cursor = TuiCursorModel(0, 0, false, TuiCursorShape.BLOCK),
      highWaterCursor = highWaterCursor,
      phase = TuiFramePhase.REPLAY_GAP,
      gapReason = reason,
    )

  private fun requireIdentity(
    expected: TuiSessionIdentity,
    actual: TuiSessionIdentity,
  ) {
    if (expected != actual) {
      throw TuiFrameException("identity_mismatch", "TUI frame belongs to another host, session, or generation")
    }
  }
}

public object TuiIntentReducer {
  public fun input(
    state: TuiFrameState,
    input: TuiInputModel,
  ): TuiIntentDecision = decision(state, TuiInteractionIntent.Input(input))

  public fun resize(
    state: TuiFrameState,
    dimensions: TuiDimensionsModel,
  ): TuiIntentDecision = decision(state, TuiInteractionIntent.Resize(dimensions))

  private fun decision(
    state: TuiFrameState,
    intent: TuiInteractionIntent,
  ): TuiIntentDecision =
    when {
      state.phase != TuiFramePhase.LIVE -> TuiIntentDecision(null, TuiIntentDisposition.RESYNC_REQUIRED)
      state.role != TuiControlRole.CONTROLLER -> TuiIntentDecision(null, TuiIntentDisposition.REQUIRES_CONTROLLER)
      else -> TuiIntentDecision(intent, TuiIntentDisposition.READY)
    }
}

private fun JsonObject.requiredObject(name: String): JsonObject =
  this[name] as? JsonObject ?: throw TuiFrameException("invalid_field", "TUI object field is invalid: $name")

private fun JsonObject.requiredArray(name: String): JsonArray =
  this[name] as? JsonArray ?: throw TuiFrameException("invalid_field", "TUI array field is invalid: $name")

private fun JsonObject.requiredBoundedString(
  name: String,
  maxLength: Int,
  allowEmpty: Boolean = false,
): String {
  val value = (this[name] as? JsonPrimitive)?.contentOrNull
  if (value == null || (!allowEmpty && value.isEmpty()) || value.length > maxLength || '\u0000' in value) {
    throw TuiFrameException(if (name == "title") "title_too_large" else "invalid_field", "TUI string field is invalid: $name")
  }
  return value
}

private fun JsonObject.optionalBoundedString(
  name: String,
  maxLength: Int,
): String? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  val value = (element as? JsonPrimitive)?.contentOrNull
  if (value == null || value.length > maxLength || value.any { it == '\u0000' || it == '\n' || it == '\r' }) {
    throw TuiFrameException(if (name == "title") "title_too_large" else "invalid_field", "TUI optional string is invalid: $name")
  }
  return value
}

private fun JsonObject.requiredBoolean(name: String): Boolean =
  (this[name] as? JsonPrimitive)?.booleanOrNull
    ?: throw TuiFrameException("invalid_field", "TUI boolean field is invalid: $name")

private fun JsonObject.optionalBoolean(name: String): Boolean? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  return (element as? JsonPrimitive)?.booleanOrNull
    ?: throw TuiFrameException("invalid_field", "TUI optional boolean is invalid: $name")
}

private fun JsonObject.requiredNonNegativeInt(name: String): Int {
  val value = (this[name] as? JsonPrimitive)?.intOrNull
  if (value == null || value < 0) throw TuiFrameException("invalid_field", "TUI integer field is invalid: $name")
  return value
}

private fun JsonObject.requiredPositiveInt(name: String): Int {
  val value = requiredNonNegativeInt(name)
  if (value < 1) throw TuiFrameException("invalid_field", "TUI integer field is invalid: $name")
  return value
}

private fun JsonObject.requiredPositiveLong(name: String): Long {
  val value = (this[name] as? JsonPrimitive)?.longOrNull
  if (value == null || value < 1) throw TuiFrameException("invalid_field", "TUI sequence is invalid")
  return value
}

private fun JsonObject.optionalColor(name: String): String? {
  val value = optionalBoundedString(name, 32) ?: return null
  if (!value.matches(Regex("^(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8}|[A-Za-z]{1,24})$"))) {
    throw TuiFrameException("invalid_style", "TUI color is invalid")
  }
  return value
}
