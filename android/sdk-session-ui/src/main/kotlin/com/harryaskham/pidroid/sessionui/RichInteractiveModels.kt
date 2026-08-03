package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness

public enum class RichAuthorityRole {
  CONTROLLER,
  OBSERVER,
  REQUESTING,
  LOST,
}

public class RichInteractiveState private constructor(
  public val authority: RichAuthorityRole,
  public val draftText: String,
  public val modelLabel: String,
  public val thinkingLevel: String,
  public val streaming: Boolean,
) {
  public val canMutate: Boolean
    get() = authority == RichAuthorityRole.CONTROLLER

  init {
    require(draftText.length <= 65_536 && '\u0000' !in draftText) { "composer draft is invalid or too long" }
    require(modelLabel.isNotBlank() && modelLabel.length <= 256) { "model label is invalid" }
    require(thinkingLevel.isNotBlank() && thinkingLevel.length <= 64) { "thinking level is invalid" }
  }

  public fun withDraft(text: String): RichInteractiveState = RichInteractiveState(authority, text, modelLabel, thinkingLevel, streaming)

  override fun toString(): String =
    "RichInteractiveState(authority=$authority, draftChars=${draftText.length}, modelLabel=$modelLabel, thinkingLevel=$thinkingLevel, streaming=$streaming, content=[REDACTED])"

  public companion object {
    public fun controller(
      draftText: String,
      modelLabel: String,
      thinkingLevel: String,
      streaming: Boolean,
    ): RichInteractiveState = RichInteractiveState(RichAuthorityRole.CONTROLLER, draftText, modelLabel, thinkingLevel, streaming)

    public fun observer(
      modelLabel: String,
      thinkingLevel: String,
    ): RichInteractiveState = RichInteractiveState(RichAuthorityRole.OBSERVER, "", modelLabel, thinkingLevel, streaming = false)
  }
}

public sealed class RichInteractionAction {
  override fun toString(): String = "RichInteractionAction(type=${this::class.simpleName}, content=[REDACTED])"

  public class DraftChanged internal constructor(
    public val text: String,
  ) : RichInteractionAction() {
    init {
      requireContent(text)
    }
  }

  public class SubmitPrompt internal constructor(
    public val text: String,
  ) : RichInteractionAction() {
    init {
      requireContent(text)
    }
  }

  public class SubmitFollowUp internal constructor(
    public val text: String,
  ) : RichInteractionAction() {
    init {
      requireContent(text)
    }
  }

  public class Steer internal constructor(
    public val text: String,
  ) : RichInteractionAction() {
    init {
      requireContent(text)
    }
  }

  public class SetModel internal constructor(
    public val provider: String,
    public val modelId: String,
  ) : RichInteractionAction() {
    init {
      requireWireValue(provider)
      requireWireValue(modelId)
    }
  }

  public class SetThinkingLevel internal constructor(
    public val level: String,
  ) : RichInteractionAction() {
    init {
      requireWireValue(level)
    }
  }

  public data object Abort : RichInteractionAction()

  public data object RequestControl : RichInteractionAction()

  public data object ReleaseControl : RichInteractionAction()

  private companion object {
    fun requireContent(value: String) {
      require(value.length <= 65_536 && '\u0000' !in value) { "interactive content is invalid or too long" }
    }

    fun requireWireValue(value: String) {
      require(value.isNotBlank() && value.length <= 256 && value.none(Char::isISOControl)) {
        "interactive setting is invalid or too long"
      }
    }
  }
}

public data class InteractiveScreenshotProfile(
  public val id: String,
  public val widthPx: Int,
  public val heightPx: Int,
  public val layout: SessionSurfaceLayout,
  public val freshness: CacheFreshness,
  public val observedAgeMillis: Long,
  public val interactive: RichInteractiveState,
)

public object InteractiveScreenshotProfiles {
  public val all: List<InteractiveScreenshotProfile> =
    listOf(
      InteractiveScreenshotProfile(
        id = "phone-controller",
        widthPx = 430,
        heightPx = 932,
        layout = SessionSurfaceLayout.phone(),
        freshness = CacheFreshness.FRESH,
        observedAgeMillis = 0,
        interactive =
          RichInteractiveState.controller(
            draftText = "Continue the release audit",
            modelLabel = "fixture-model",
            thinkingLevel = "medium",
            streaming = true,
          ),
      ),
      InteractiveScreenshotProfile(
        id = "tablet-observer",
        widthPx = 1_280,
        heightPx = 800,
        layout = SessionSurfaceLayout.tablet(),
        freshness = CacheFreshness.RECONNECTING,
        observedAgeMillis = 2_000,
        interactive = RichInteractiveState.observer("fixture-model", "medium"),
      ),
    )
}
