package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.protocol.generated.PiRpcCommandType
import com.harryaskham.pidroid.sdk.core.CommandLifecycle
import com.harryaskham.pidroid.sdk.core.CorrelationId
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.InteractiveConnectionState
import com.harryaskham.pidroid.sdk.core.InteractiveControllerRole
import com.harryaskham.pidroid.sdk.core.InteractiveSessionController
import com.harryaskham.pidroid.sdk.core.SessionCommandIntent
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sdk.core.SessionRpcFrame
import com.harryaskham.pidroid.sdk.core.SessionRpcFrameCodec
import com.harryaskham.pidroid.sessionui.InteractiveSessionIdentity
import com.harryaskham.pidroid.sessionui.RichInteractionAction
import com.harryaskham.pidroid.sessionui.RichInteractiveState
import com.harryaskham.pidroid.sessionui.SessionTreeEntry
import com.harryaskham.pidroid.sessionui.SessionTreeEntryKind
import com.harryaskham.pidroid.sessionui.SessionTreeSnapshot
import com.harryaskham.pidroid.sessionui.TuiControlRole
import com.harryaskham.pidroid.sessionui.TuiFrameDecoder
import com.harryaskham.pidroid.sessionui.TuiFrameReducer
import com.harryaskham.pidroid.sessionui.TuiFrameState
import com.harryaskham.pidroid.sessionui.TuiInputModel
import com.harryaskham.pidroid.sessionui.TuiIntentDecision
import com.harryaskham.pidroid.sessionui.TuiIntentReducer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

public data class LiveCommandReceipt(
  public val correlationId: String,
  public val kind: PiRpcCommandType,
  public val lifecycle: CommandLifecycle,
)

public class LiveInteractiveSnapshot internal constructor(
  public val connection: InteractiveConnectionState,
  public val role: InteractiveControllerRole,
  public val rich: RichInteractiveState,
  public val highWaterCursor: String?,
  public val receipts: List<LiveCommandReceipt>,
  public val tree: SessionTreeSnapshot?,
  public val streaming: Boolean,
) {
  override fun toString(): String =
    "LiveInteractiveSnapshot(connection=$connection, role=$role, receipts=${receipts.size}, tree=${tree != null}, streaming=$streaming, cursor=[REDACTED], content=[REDACTED])"
}

/**
 * App-facing state machine over canonical sdk-core controller/correlation semantics.
 *
 * It owns no socket and performs no retries. Callers send returned frames once, feed received frames
 * through [accept], and call [disconnected] when acknowledgement becomes unknowable.
 */
public class LiveInteractiveSessionMachine(
  session: SessionKey,
  supportedCommands: Set<PiRpcCommandType>,
  authority: HostAuthority,
  private val modelLabel: String,
  private val thinkingLevel: String,
) {
  private val controller =
    InteractiveSessionController(
      session = session,
      supportedCommands = supportedCommands,
      expectedHostInstanceId = authority.hostInstanceId,
    )
  private val issued = linkedMapOf<String, PiRpcCommandType>()
  private val identity = InteractiveSessionIdentity(authority, session.sessionId, session.generation)
  private var draft = ""
  private var streaming = false
  private var tree: SessionTreeSnapshot? = null

  public val snapshot: LiveInteractiveSnapshot
    @Synchronized get() = current()

  @Synchronized
  public fun accept(text: String) {
    val frame = SessionRpcFrameCodec.decode(text)
    controller.onFrame(frame)
    when (frame) {
      is SessionRpcFrame.AttachReady -> {
        val rpcState = frame.snapshot["rpcState"] as? JsonObject
        streaming = (rpcState?.get("isStreaming") as? JsonPrimitive)?.booleanOrNull ?: false
      }

      is SessionRpcFrame.Event -> {
        val event = frame.raw["event"] as? JsonObject
        when ((event?.get("type") as? JsonPrimitive)?.contentOrNull) {
          "agent_start" -> streaming = true
          "agent_settled" -> streaming = false
        }
      }

      is SessionRpcFrame.Response -> {
        val response = frame.raw["response"] as? JsonObject
        if (
          (response?.get("success") as? JsonPrimitive)?.booleanOrNull == true &&
          (response["command"] as? JsonPrimitive)?.contentOrNull == PiRpcCommandType.GET_TREE.wireValue
        ) {
          tree = LiveTreeResponseDecoder.decode(response, identity)
        }
      }

      is SessionRpcFrame.ReplayGap -> {
        streaming = false
      }

      else -> {
        // Non-lifecycle frames remain inert until their exact app feature consumes them.
      }
    }
  }

  @Synchronized
  public fun requestControl(): String = controller.requestControl().text

  @Synchronized
  public fun releaseControl(): String = controller.releaseControl().text

  @Synchronized
  public fun changeDraft(text: String) {
    draft = text.take(65_536).replace("\u0000", "")
  }

  @Synchronized
  public fun submit(
    action: RichInteractionAction,
    idempotencyKey: String,
  ): String {
    val intent =
      when (action) {
        is RichInteractionAction.SubmitPrompt -> {
          SessionCommandIntent.prompt(action.text)
        }

        is RichInteractionAction.SubmitFollowUp -> {
          SessionCommandIntent.followUp(action.text)
        }

        is RichInteractionAction.Steer -> {
          SessionCommandIntent.steer(action.text)
        }

        is RichInteractionAction.SetModel -> {
          SessionCommandIntent.setModel(action.provider, action.modelId)
        }

        is RichInteractionAction.SetThinkingLevel -> {
          SessionCommandIntent.setThinkingLevel(action.level)
        }

        RichInteractionAction.Abort -> {
          SessionCommandIntent.abort()
        }

        is RichInteractionAction.DraftChanged -> {
          changeDraft(action.text)
          return ""
        }

        RichInteractionAction.RequestControl,
        RichInteractionAction.ReleaseControl,
        -> {
          throw IllegalArgumentException("control actions use the explicit control methods")
        }
      }
    val correlation = CorrelationId(idempotencyKey)
    val outbound = controller.submit(intent, correlation)
    issued[idempotencyKey] = intent.kind
    if (action is RichInteractionAction.SubmitPrompt || action is RichInteractionAction.SubmitFollowUp) draft = ""
    return outbound.text
  }

  @Synchronized
  public fun requestTree(idempotencyKey: String): String {
    val intent = SessionCommandIntent.getTree()
    val correlation = CorrelationId(idempotencyKey)
    val outbound = controller.submit(intent, correlation)
    issued[idempotencyKey] = intent.kind
    return outbound.text
  }

  @Synchronized
  public fun disconnected() {
    controller.onDisconnect()
    streaming = false
  }

  override fun toString(): String = "LiveInteractiveSessionMachine(snapshot=$snapshot, content=[REDACTED])"

  private fun current(): LiveInteractiveSnapshot {
    val state = controller.state
    val rich =
      when (state.role) {
        InteractiveControllerRole.CONTROLLER -> RichInteractiveState.controller(draft, modelLabel, thinkingLevel, streaming)

        InteractiveControllerRole.REQUESTING -> RichInteractiveState.requesting(modelLabel, thinkingLevel)

        InteractiveControllerRole.LOST,
        InteractiveControllerRole.DENIED,
        -> RichInteractiveState.lost(modelLabel, thinkingLevel)

        InteractiveControllerRole.OBSERVER -> RichInteractiveState.observer(modelLabel, thinkingLevel)
      }
    val receipts =
      issued.map { (id, kind) ->
        LiveCommandReceipt(id, kind, requireNotNull(controller.command(id)).lifecycle)
      }
    return LiveInteractiveSnapshot(
      connection = state.connection,
      role = state.role,
      rich = rich,
      highWaterCursor = state.highWaterCursor,
      receipts = receipts,
      tree = tree,
      streaming = streaming,
    )
  }
}

/** Decoder for stock Pi `get_tree`; entry content is deliberately never projected. */
private object LiveTreeResponseDecoder {
  private const val MAX_NODES = 256

  fun decode(
    response: JsonObject,
    identity: InteractiveSessionIdentity,
  ): SessionTreeSnapshot {
    val data = response.requiredObject("data")
    val leafId = data.requiredIdentifier("leafId")
    val roots = data["tree"] as? JsonArray ?: throw LiveReadonlyFailure("invalid_tree")
    val entries = mutableListOf<SessionTreeEntry>()

    fun visit(node: JsonObject) {
      if (entries.size >= MAX_NODES) throw LiveReadonlyFailure("tree_too_large")
      val entry = node.requiredObject("entry")
      val id = entry.requiredIdentifier("id")
      val parentId = entry.optionalIdentifier("parentId")
      val type = entry.requiredWireValue("type")
      val label =
        (node["label"] as? JsonPrimitive)
          ?.contentOrNull
          ?.takeIf { it.isNotBlank() && it.length <= 256 && '\n' !in it && '\r' !in it }
          ?: type.replace('_', ' ').replaceFirstChar(Char::uppercase)
      entries +=
        SessionTreeEntry(
          id = id,
          parentId = parentId,
          kind = entryKind(type, label),
          label = label,
          active = id == leafId,
        )
      val children = node["children"] as? JsonArray ?: JsonArray(emptyList())
      children.forEach { child -> visit(child as? JsonObject ?: throw LiveReadonlyFailure("invalid_tree")) }
    }

    roots.forEach { root -> visit(root as? JsonObject ?: throw LiveReadonlyFailure("invalid_tree")) }
    return SessionTreeSnapshot(identity, entries, leafId)
  }

  private fun entryKind(
    type: String,
    label: String,
  ): SessionTreeEntryKind =
    when {
      type == "session_info" || type.endsWith("_change") -> SessionTreeEntryKind.SYSTEM
      type.contains("tool") -> SessionTreeEntryKind.TOOL
      label.equals("user", true) -> SessionTreeEntryKind.USER
      label.equals("assistant", true) -> SessionTreeEntryKind.ASSISTANT
      else -> SessionTreeEntryKind.UNKNOWN
    }
}

public class LiveTuiSessionMachine {
  private val json = Json

  public var state: TuiFrameState? = null
    private set

  public fun accept(text: String) {
    val root = json.parseToJsonElement(text).jsonObject
    when (root.requiredWireValue("kind")) {
      "snapshot" -> {
        val role =
          when ((root["role"] as? JsonPrimitive)?.contentOrNull) {
            "controller" -> TuiControlRole.CONTROLLER
            "observer" -> TuiControlRole.OBSERVER
            else -> throw LiveReadonlyFailure("invalid_tui_role")
          }
        state = TuiFrameDecoder.decodeSnapshot(root.requiredObject("snapshot").toString(), role)
      }

      "delta" -> {
        state = TuiFrameReducer.applyDelta(requireNotNull(state), TuiFrameDecoder.decodeDelta(root.requiredObject("delta").toString()))
      }

      "replay_gap" -> {
        state =
          TuiFrameReducer.applyReplayGap(
            requireNotNull(state),
            TuiFrameDecoder.decodeReplayGap(root.requiredObject("gap").toString()),
          )
      }

      else -> {
        // Acknowledgement/control frames do not alter the rendered terminal snapshot.
      }
    }
  }

  public fun input(input: TuiInputModel): TuiIntentDecision = TuiIntentReducer.input(requireNotNull(state), input)

  override fun toString(): String = "LiveTuiSessionMachine(state=$state, content=[REDACTED])"
}

private val IDENTIFIER = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
private val WIRE_VALUE = Regex("^[a-z][a-z0-9_]{0,127}$")

private fun JsonObject.requiredObject(name: String): JsonObject = this[name] as? JsonObject ?: throw LiveReadonlyFailure("invalid_$name")

private fun JsonObject.requiredIdentifier(name: String): String =
  (this[name] as? JsonPrimitive)
    ?.contentOrNull
    ?.takeIf(IDENTIFIER::matches)
    ?: throw LiveReadonlyFailure("invalid_$name")

private fun JsonObject.optionalIdentifier(name: String): String? {
  val value = this[name] ?: return null
  if (value == JsonNull) return null
  return (value as? JsonPrimitive)
    ?.contentOrNull
    ?.takeIf(IDENTIFIER::matches)
    ?: throw LiveReadonlyFailure("invalid_$name")
}

private fun JsonObject.requiredWireValue(name: String): String =
  (this[name] as? JsonPrimitive)
    ?.contentOrNull
    ?.takeIf(WIRE_VALUE::matches)
    ?: throw LiveReadonlyFailure("invalid_$name")
