package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.SessionRole

public sealed interface ExtensionNode {
  public val wireType: String
  public val accessibilityLabel: String

  public data class Container(
    override val wireType: String,
    public val children: List<ExtensionNode>,
  ) : ExtensionNode {
    override val accessibilityLabel: String = "Extension $wireType container, ${children.size} items"
  }

  public class Content(
    override val wireType: String,
    public val label: String,
    public val detail: String?,
  ) : ExtensionNode {
    override val accessibilityLabel: String = "Extension $wireType: $label"

    override fun toString(): String = "ExtensionNode.Content(type=$wireType, label=$label, detail=[REDACTED])"
  }

  public data class Action(
    public val actionId: String,
    public val label: String,
    public val tone: String,
  ) : ExtensionNode {
    override val wireType: String = "action"
    override val accessibilityLabel: String = "Extension action $label"
  }

  public data class Form(
    public val formId: String,
    public val submitActionId: String,
    public val submitLabel: String,
    public val fields: List<ExtensionFormField>,
  ) : ExtensionNode {
    override val wireType: String = "form"
    override val accessibilityLabel: String = "Extension form $submitLabel, ${fields.size} fields"
  }

  public data class Unsupported(
    override val wireType: String,
    public val fallbackText: String,
  ) : ExtensionNode {
    override val accessibilityLabel: String = "Unsupported extension node $wireType; fallback available"
  }
}

public data class ExtensionFormField(
  public val type: String,
  public val name: String,
  public val label: String,
  public val required: Boolean,
  public val options: Set<String>,
) {
  init {
    require(type in setOf("text", "multiline", "select", "boolean")) { "extension form field type is unsupported" }
    require(name.isInteractiveIdentifier()) { "extension form field name is invalid" }
    require(label.isNotBlank() && label.length <= 256) { "extension form field label is invalid" }
    require(options.size <= 64 && options.all { it.length in 1..256 }) { "extension form options are invalid" }
    require(type != "select" || options.isNotEmpty()) { "extension select field requires options" }
    require(type == "select" || options.isEmpty()) { "only extension select fields may declare options" }
  }
}

public sealed interface ExtensionFormValue {
  public class Text(
    public val value: String,
  ) : ExtensionFormValue {
    init {
      require(value.length <= 4_096) { "extension text value exceeds bound" }
    }

    override fun toString(): String = "ExtensionFormValue.Text(chars=${value.length}, value=[REDACTED])"
  }

  public data class Toggle(
    public val value: Boolean,
  ) : ExtensionFormValue
}

public data class ExtensionViewState(
  public val identity: InteractiveSessionIdentity,
  public val freshness: CacheFreshness,
  public val correlationId: String,
  public val requestId: String,
  public val viewId: String,
  public val revision: Int,
  public val title: String,
  public val fallbackText: String,
  public val actions: Set<String>,
  public val root: ExtensionNode,
) {
  public val nodes: List<ExtensionNode> = flatten(root)

  init {
    require(correlationId.isInteractiveIdentifier()) { "extension correlation ID is invalid" }
    require(requestId.isInteractiveIdentifier()) { "extension request ID is invalid" }
    require(viewId.isInteractiveIdentifier()) { "extension view ID is invalid" }
    require(revision >= 0) { "extension revision must be non-negative" }
    require(title.isNotBlank() && title.length <= 256) { "extension title is invalid" }
    require(fallbackText.isNotBlank() && fallbackText.length <= 4_096) { "extension fallback is invalid" }
    require(actions.size <= 64 && actions.all(String::isInteractiveIdentifier)) { "extension actions are invalid" }
    require(nodes.size <= MAX_NODES) { "extension node count exceeds bound" }
  }

  override fun toString(): String =
    "ExtensionViewState(session=${identity.sessionId}, generation=${identity.generation}, viewId=$viewId, revision=$revision, nodes=${nodes.size}, freshness=$freshness, content=[REDACTED])"

  public companion object {
    public const val MAX_NODES: Int = 256
    public const val MAX_DEPTH: Int = 16

    private fun flatten(root: ExtensionNode): List<ExtensionNode> {
      val result = mutableListOf<ExtensionNode>()

      fun visit(
        node: ExtensionNode,
        depth: Int,
      ) {
        require(depth <= MAX_DEPTH) { "extension node depth exceeds bound" }
        require(result.size < MAX_NODES) { "extension node count exceeds bound" }
        result += node
        if (node is ExtensionNode.Container) node.children.forEach { visit(it, depth + 1) }
      }
      visit(root, 0)
      return result
    }
  }
}

public class ExtensionActionIntent(
  public val identity: InteractiveSessionIdentity,
  public val correlationId: String,
  public val requestId: String,
  public val viewId: String,
  public val revision: Int,
  public val actionId: String,
  public val values: Map<String, ExtensionFormValue>,
) {
  init {
    require(correlationId.isInteractiveIdentifier()) { "extension correlation ID is invalid" }
    require(requestId.isInteractiveIdentifier()) { "extension request ID is invalid" }
    require(viewId.isInteractiveIdentifier()) { "extension view ID is invalid" }
    require(actionId.isInteractiveIdentifier()) { "extension action ID is invalid" }
    require(revision >= 0) { "extension revision must be non-negative" }
    require(values.size <= 32 && values.keys.all(String::isInteractiveIdentifier)) { "extension form values exceed bounds" }
  }

  override fun toString(): String =
    "ExtensionActionIntent(session=${identity.sessionId}, generation=${identity.generation}, correlationId=$correlationId, viewId=$viewId, revision=$revision, actionId=$actionId, values=[REDACTED])"
}

public data class ExtensionUiResponseReceipt(
  public val correlationId: String,
  public val requestId: String,
  public val confirmed: Boolean,
)

public object ExtensionInteractionAuthority {
  public fun authorizeAction(
    view: ExtensionViewState,
    actionId: String,
    values: Map<String, ExtensionFormValue>,
    context: InteractionContext,
  ): InteractionDecision<ExtensionActionIntent> {
    if (view.identity != context.identity) return InteractionDecision.Blocked("identity_mismatch")
    if (context.role != SessionRole.CONTROLLER) return InteractionDecision.Blocked("controller_required")
    if (view.freshness != CacheFreshness.FRESH || context.freshness != CacheFreshness.FRESH) {
      return InteractionDecision.Blocked("freshness_required")
    }
    if (actionId !in view.actions) return InteractionDecision.Blocked("action_not_declared")
    val actionNode = view.nodes.filterIsInstance<ExtensionNode.Action>().firstOrNull { it.actionId == actionId }
    val formNode = view.nodes.filterIsInstance<ExtensionNode.Form>().firstOrNull { it.submitActionId == actionId }
    if (actionNode == null && formNode == null) return InteractionDecision.Blocked("action_not_rendered")
    if (formNode != null) {
      val requiredFields = formNode.fields.filter(ExtensionFormField::required).mapTo(hashSetOf(), ExtensionFormField::name)
      if (!values.keys.containsAll(requiredFields)) return InteractionDecision.Blocked("required_values_missing")
      val fields = formNode.fields.associateBy(ExtensionFormField::name)
      if (!fields.keys.containsAll(values.keys)) return InteractionDecision.Blocked("unknown_form_value")
      val invalidValue =
        values.any { (name, value) ->
          val field = fields.getValue(name)
          when (field.type) {
            "text", "multiline" -> value !is ExtensionFormValue.Text
            "boolean" -> value !is ExtensionFormValue.Toggle
            "select" -> value !is ExtensionFormValue.Text || value.value !in field.options
            else -> true
          }
        }
      if (invalidValue) return InteractionDecision.Blocked("invalid_form_value")
    }
    return InteractionDecision.Ready(
      ExtensionActionIntent(
        identity = view.identity,
        correlationId = view.correlationId,
        requestId = view.requestId,
        viewId = view.viewId,
        revision = view.revision,
        actionId = actionId,
        values = values.toMap(),
      ),
    )
  }
}

private fun String.isInteractiveIdentifier(): Boolean = matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))
