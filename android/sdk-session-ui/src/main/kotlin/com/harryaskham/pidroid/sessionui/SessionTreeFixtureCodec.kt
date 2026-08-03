package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.protocol.generated.GeneratedProtocolContracts
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** Fixture-backed, transport-free codec for the canonical tree navigation contract. */
public object SessionTreeFixtureCodec {
  private const val MAX_FIXTURE_BYTES: Int = 1_048_576
  private val json: Json = Json
  private val requiredInputs: Set<String> =
    setOf(
      "fixtures/session-api/rpc.tree-navigate.frame.json",
      "fixtures/session-api/rpc.tree-navigate-result.frame.json",
    )

  public fun decodeIntent(
    text: String,
    identity: InteractiveSessionIdentity,
  ): TreeNavigationIntent {
    requireGeneratedInputs()
    val root = decodeObject(text, "tree navigation fixture")
    if (root.interactiveRequiredString("kind") != "tree_navigate") {
      throw InteractiveSurfaceException("unsupported_kind", "tree navigation fixture kind is unsupported")
    }
    val request = root.interactiveRequiredObject("request")
    return TreeNavigationIntent(
      identity = identity,
      correlationId = root.interactiveRequiredIdentifier("correlationId"),
      entryId = request.interactiveRequiredIdentifier("entryId"),
      summarize = request.interactiveRequiredBoolean("summarize"),
      customInstructions = request.interactiveOptionalString("customInstructions", 4_096),
      label = request.interactiveOptionalIdentifier("label"),
    )
  }

  public fun decodeResult(
    text: String,
    pending: TreeNavigationIntent,
  ): TreeNavigationResult {
    requireGeneratedInputs()
    val root = decodeObject(text, "tree navigation result fixture")
    if (root.interactiveRequiredString("kind") != "tree_navigate_result") {
      throw InteractiveSurfaceException("unsupported_kind", "tree navigation result fixture kind is unsupported")
    }
    val correlationId = root.interactiveRequiredIdentifier("correlationId")
    if (correlationId != pending.correlationId) {
      throw InteractiveSurfaceException("correlation_mismatch", "tree navigation result correlation is stale")
    }
    val result = root.interactiveRequiredObject("result")
    return TreeNavigationResult(
      correlationId = correlationId,
      cancelled = result.interactiveRequiredBoolean("cancelled"),
      editorText = result.interactiveOptionalString("editorText", 16_384),
      summaryEntryId = result.interactiveOptionalIdentifier("summaryEntryId"),
    )
  }

  private fun requireGeneratedInputs() {
    val generated = GeneratedProtocolContracts.inputs.mapTo(hashSetOf()) { it.path }
    if (!generated.containsAll(requiredInputs)) {
      throw IllegalStateException("generated protocol inputs do not contain the tree fixtures")
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

internal fun JsonObject.interactiveRequiredObject(name: String): JsonObject =
  this[name] as? JsonObject
    ?: throw InteractiveSurfaceException("invalid_field", "required object is missing or invalid: $name")

internal fun JsonObject.interactiveRequiredString(
  name: String,
  maxLength: Int = 8_192,
): String {
  val value = (this[name] as? JsonPrimitive)?.contentOrNull
  if (value == null || value.isEmpty() || value.length > maxLength) {
    throw InteractiveSurfaceException("invalid_field", "required string is missing or invalid: $name")
  }
  return value
}

internal fun JsonObject.interactiveOptionalString(
  name: String,
  maxLength: Int = 8_192,
): String? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  return (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.length <= maxLength }
    ?: throw InteractiveSurfaceException("invalid_field", "optional string is invalid: $name")
}

internal fun JsonObject.interactiveRequiredIdentifier(name: String): String =
  interactiveRequiredString(name, 128).takeIf { it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")) }
    ?: throw InteractiveSurfaceException("invalid_field", "identifier is invalid: $name")

internal fun JsonObject.interactiveOptionalIdentifier(name: String): String? =
  interactiveOptionalString(name, 128)?.takeIf { it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")) }
    ?: if (this[name] == null || this[name] == JsonNull) {
      null
    } else {
      throw InteractiveSurfaceException("invalid_field", "optional identifier is invalid: $name")
    }

internal fun JsonObject.interactiveRequiredBoolean(name: String): Boolean =
  (this[name] as? JsonPrimitive)?.booleanOrNull
    ?: throw InteractiveSurfaceException("invalid_field", "required boolean is missing or invalid: $name")
