package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.protocol.generated.GeneratedProtocolContracts
import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** Decodes server-validated declarative fixtures into inert Android view data. */
public object ExtensionViewFixtureCodec {
  private const val MAX_FIXTURE_BYTES: Int = 2 * 1_048_576
  private val json: Json = Json
  private val requiredInputs: Set<String> =
    setOf(
      "extension-view.schema.json",
      "fixtures/extension-view/response.valid.json",
      "fixtures/dashboard-api/stream.extension-view.json",
      "fixtures/dashboard-api/stream.extension-ui-response.json",
    )

  public fun decodeStream(
    text: String,
    freshness: CacheFreshness,
    hostId: HostId,
    bearerGeneration: Int,
  ): ExtensionViewState {
    requireGeneratedInputs()
    val root = decodeObject(text, "extension view stream fixture")
    if (root.interactiveRequiredString("kind") != "session_event") {
      throw InteractiveSurfaceException("unsupported_kind", "extension stream fixture kind is unsupported")
    }
    val event = root.interactiveRequiredObject("event")
    if (event.interactiveRequiredString("kind") != "extension_view") {
      throw InteractiveSurfaceException("unsupported_kind", "session event is not an extension view")
    }
    val provenance = event.interactiveRequiredObject("provenance")
    if (provenance.interactiveRequiredString("validation") != "validated" ||
      provenance.interactiveRequiredBoolean("browserCodeExecution")
    ) {
      throw InteractiveSurfaceException("untrusted_view", "extension view is not server-validated inert data")
    }
    val identity = event.interactiveRequiredObject("identity")
    val interactiveIdentity =
      InteractiveSessionIdentity(
        authority =
          HostAuthority(
            hostId = hostId,
            bearerGeneration = bearerGeneration,
            hostInstanceId = identity.interactiveRequiredIdentifier("hostInstanceId"),
          ),
        sessionId = identity.interactiveRequiredIdentifier("sessionId"),
        generation = identity.interactiveRequiredNonNegativeInt("generation"),
      )
    val fallbackText = event.interactiveRequiredObject("fallback").interactiveRequiredString("text", 4_096)
    return decodeView(
      view = event.interactiveRequiredObject("view"),
      identity = interactiveIdentity,
      freshness = freshness,
      correlationId = root.interactiveRequiredIdentifier("correlationId"),
      requestId = event.interactiveRequiredIdentifier("requestId"),
      fallbackText = fallbackText,
    )
  }

  public fun decodeFormResponse(
    text: String,
    view: ExtensionViewState,
    correlationId: String,
  ): ExtensionActionIntent {
    requireGeneratedInputs()
    val root = decodeObject(text, "extension form response fixture")
    if (root.interactiveRequiredString("protocol") != "pi-declarative-view" || root.interactiveRequiredString("version") != "1.0") {
      throw InteractiveSurfaceException("unsupported_protocol", "extension form response protocol is unsupported")
    }
    if (root.interactiveRequiredIdentifier("viewId") != view.viewId ||
      root.interactiveRequiredNonNegativeInt("revision") != view.revision
    ) {
      throw InteractiveSurfaceException("stale_revision", "extension form response targets a stale view")
    }
    val actionId = root.interactiveRequiredIdentifier("actionId")
    if (actionId !in view.actions) {
      throw InteractiveSurfaceException("action_not_declared", "extension form response action is not declared")
    }
    val form =
      view.nodes.filterIsInstance<ExtensionNode.Form>().firstOrNull { it.submitActionId == actionId }
        ?: throw InteractiveSurfaceException("action_not_rendered", "extension form response action is not rendered")
    val allowedFields = form.fields.mapTo(hashSetOf(), ExtensionFormField::name)
    val values = root.interactiveRequiredObject("values")
    if (values.size > 32 || !allowedFields.containsAll(values.keys)) {
      throw InteractiveSurfaceException("invalid_values", "extension form values exceed declared fields")
    }
    val decoded =
      values.mapValues { (_, element) ->
        val primitive =
          element as? JsonPrimitive
            ?: throw InteractiveSurfaceException("invalid_values", "extension form value must be primitive")
        primitive.booleanOrNull?.let(ExtensionFormValue::Toggle)
          ?: primitive.contentOrNull?.takeIf { it.length <= 4_096 }?.let(ExtensionFormValue::Text)
          ?: throw InteractiveSurfaceException("invalid_values", "extension form value is invalid")
      }
    return ExtensionActionIntent(
      identity = view.identity,
      correlationId = correlationId,
      requestId = view.requestId,
      viewId = view.viewId,
      revision = view.revision,
      actionId = actionId,
      values = decoded,
    )
  }

  public fun correlateUiResponse(
    text: String,
    pending: ExtensionActionIntent,
  ): ExtensionUiResponseReceipt {
    requireGeneratedInputs()
    val root = decodeObject(text, "extension UI response fixture")
    if (root.interactiveRequiredString("kind") != "extension_ui_response") {
      throw InteractiveSurfaceException("unsupported_kind", "extension UI response kind is unsupported")
    }
    val correlationId = root.interactiveRequiredIdentifier("correlationId")
    if (correlationId != pending.correlationId) {
      throw InteractiveSurfaceException("correlation_mismatch", "extension UI response correlation is stale")
    }
    return ExtensionUiResponseReceipt(
      correlationId = correlationId,
      requestId = root.interactiveRequiredIdentifier("requestId"),
      confirmed = root.interactiveRequiredObject("response").interactiveRequiredBoolean("confirmed"),
    )
  }

  private fun decodeView(
    view: JsonObject,
    identity: InteractiveSessionIdentity,
    freshness: CacheFreshness,
    correlationId: String,
    requestId: String,
    fallbackText: String,
  ): ExtensionViewState {
    if (view.interactiveRequiredString("protocol") != "pi-declarative-view" || view.interactiveRequiredString("version") != "1.0") {
      throw InteractiveSurfaceException("unsupported_protocol", "extension view protocol is unsupported")
    }
    val capabilities = view.interactiveRequiredObject("capabilities")
    val actions = capabilities.interactiveRequiredStringSet("actions", 64)
    var nodeCount = 0

    fun decodeNode(
      node: JsonObject,
      depth: Int,
    ): ExtensionNode {
      if (depth > ExtensionViewState.MAX_DEPTH || ++nodeCount > ExtensionViewState.MAX_NODES) {
        throw InteractiveSurfaceException("node_limit", "extension view exceeds node bounds")
      }
      val wireType = node.interactiveRequiredString("type", 128)
      return when (wireType) {
        "stack", "grid" -> {
          val children = node.interactiveRequiredArray("children", ExtensionViewState.MAX_NODES)
          ExtensionNode.Container(wireType, children.map { decodeNode(it.interactiveRequiredObjectValue("child"), depth + 1) })
        }

        "text" -> {
          val text = node.interactiveRequiredString("text", 65_536)
          ExtensionNode.Content(wireType, text.take(256), null)
        }

        "markdown" -> {
          val text = node.interactiveRequiredString("text", 65_536)
          val lines = text.lines()
          ExtensionNode.Content(
            wireType = wireType,
            label = lines.first().trimStart('#', ' ').take(256),
            detail =
              lines
                .drop(1)
                .joinToString("\n")
                .trim()
                .takeIf(String::isNotEmpty),
          )
        }

        "status" -> {
          ExtensionNode.Content(wireType, node.interactiveRequiredString("label", 256), node.interactiveOptionalString("detail", 4_096))
        }

        "code" -> {
          ExtensionNode.Content(
            wireType,
            node.interactiveOptionalString("filename", 256) ?: "Code",
            node.interactiveRequiredString("code", 65_536),
          )
        }

        "diff" -> {
          ExtensionNode.Content(wireType, "Diff", node.interactiveRequiredString("diff", 65_536))
        }

        "image" -> {
          ExtensionNode.Content(wireType, node.interactiveRequiredString("alt", 512), null)
        }

        "key-value" -> {
          ExtensionNode.Content(wireType, "Key-value details", "${node.interactiveRequiredArray("entries", 128).size} entries")
        }

        "action" -> {
          ExtensionNode.Action(
            node.interactiveRequiredIdentifier("actionId"),
            node.interactiveRequiredString("label", 256),
            node.interactiveOptionalString("tone", 32) ?: "default",
          )
        }

        "form" -> {
          decodeForm(node)
        }

        else -> {
          ExtensionNode.Unsupported(wireType.take(128), fallbackText)
        }
      }
    }
    return ExtensionViewState(
      identity = identity,
      freshness = freshness,
      correlationId = correlationId,
      requestId = requestId,
      viewId = view.interactiveRequiredIdentifier("viewId"),
      revision = view.interactiveRequiredNonNegativeInt("revision"),
      title = view.interactiveRequiredString("title", 256),
      fallbackText = view.interactiveRequiredString("fallbackText", 4_096).takeIf { it == fallbackText } ?: fallbackText,
      actions = actions,
      root = decodeNode(view.interactiveRequiredObject("root"), 0),
    )
  }

  private fun decodeForm(node: JsonObject): ExtensionNode.Form {
    val fields =
      node.interactiveRequiredArray("fields", 32).map { element ->
        val field = element.interactiveRequiredObjectValue("field")
        val options =
          when (val optionElement = field["options"]) {
            null -> {
              emptySet()
            }

            is JsonArray -> {
              optionElement.mapTo(linkedSetOf()) { option ->
                option.interactiveRequiredObjectValue("option").interactiveRequiredString("value", 256)
              }
            }

            else -> {
              throw InteractiveSurfaceException("invalid_field", "extension form options must be an array")
            }
          }
        ExtensionFormField(
          type = field.interactiveRequiredString("type", 32),
          name = field.interactiveRequiredIdentifier("name"),
          label = field.interactiveRequiredString("label", 256),
          required = (field["required"] as? JsonPrimitive)?.booleanOrNull ?: false,
          options = options,
        )
      }
    return ExtensionNode.Form(
      formId = node.interactiveRequiredIdentifier("formId"),
      submitActionId = node.interactiveRequiredIdentifier("submitActionId"),
      submitLabel = node.interactiveRequiredString("submitLabel", 256),
      fields = fields,
    )
  }

  private fun requireGeneratedInputs() {
    val generated = GeneratedProtocolContracts.inputs.mapTo(hashSetOf()) { it.path }
    if (!generated.containsAll(requiredInputs)) {
      throw IllegalStateException("generated protocol inputs do not contain extension fixtures")
    }
  }

  private fun decodeObject(
    text: String,
    label: String,
  ): JsonObject {
    if (text.encodeToByteArray().size > MAX_FIXTURE_BYTES) {
      throw InteractiveSurfaceException("message_too_large", "$label exceeds the safety bound")
    }
    return try {
      json.parseToJsonElement(text) as? JsonObject
        ?: throw InteractiveSurfaceException("invalid_shape", "$label must be an object")
    } catch (error: InteractiveSurfaceException) {
      throw error
    } catch (_: Exception) {
      throw InteractiveSurfaceException("invalid_json", "$label is invalid JSON")
    }
  }
}

internal fun JsonObject.interactiveRequiredArray(
  name: String,
  maxSize: Int,
): JsonArray {
  val value =
    this[name] as? JsonArray
      ?: throw InteractiveSurfaceException("invalid_field", "required array is missing or invalid: $name")
  if (value.size > maxSize) throw InteractiveSurfaceException("invalid_field", "required array exceeds bound: $name")
  return value
}

internal fun JsonObject.interactiveRequiredStringSet(
  name: String,
  maxSize: Int,
): Set<String> =
  interactiveRequiredArray(name, maxSize).mapTo(linkedSetOf()) { element ->
    (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")) }
      ?: throw InteractiveSurfaceException("invalid_field", "string set member is invalid: $name")
  }

internal fun JsonObject.interactiveRequiredNonNegativeInt(name: String): Int {
  val value =
    (this[name] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()
      ?: throw InteractiveSurfaceException("invalid_field", "required integer is missing or invalid: $name")
  if (value < 0) throw InteractiveSurfaceException("invalid_field", "required integer is negative: $name")
  return value
}

internal fun JsonElement.interactiveRequiredObjectValue(label: String): JsonObject =
  this as? JsonObject
    ?: throw InteractiveSurfaceException("invalid_field", "$label must be an object")
