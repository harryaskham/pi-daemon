package com.harryaskham.pidroid.sdk.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

public class ProtocolDecodeException(
  public val code: String,
  message: String,
) : IllegalArgumentException(message)

public sealed interface ApiResult<out T> {
  public val requestId: String
  public val hostInstanceId: String

  public class Success<T>(
    override val requestId: String,
    override val hostInstanceId: String,
    public val value: T,
  ) : ApiResult<T> {
    override fun toString(): String = "ApiResult.Success(requestId=$requestId, hostInstanceId=$hostInstanceId, value=[REDACTED])"
  }

  public class Failure(
    override val requestId: String,
    override val hostInstanceId: String,
    public val error: SafeApiError,
  ) : ApiResult<Nothing> {
    override fun toString(): String =
      "ApiResult.Failure(requestId=$requestId, hostInstanceId=$hostInstanceId, code=${error.code}, retryable=${error.retryable})"
  }
}

public class SafeApiError(
  public val code: String,
  public val message: String,
  public val retryable: Boolean,
  public val details: JsonObject,
) {
  override fun toString(): String = "SafeApiError(code=$code, retryable=$retryable)"
}

public class HostCapabilities(
  public val apiVersion: String,
  public val transports: Set<String>,
  public val rpcSubprotocols: Set<String>,
  public val authentication: String,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "HostCapabilities(apiVersion=$apiVersion, transports=$transports, rpcSubprotocols=$rpcSubprotocols, authentication=$authentication, additionalFieldCount=${additionalFields.size})"
}

/**
 * Durable mutation state. [INDETERMINATE] is terminal for blind replay: reconcile the same ticket or
 * resource using its existing request/idempotency identity before considering another command.
 */
public enum class TicketState(
  public val wireValue: String,
) {
  QUEUED("queued"),
  RUNNING("running"),
  SUCCEEDED("succeeded"),
  FAILED("failed"),
  INDETERMINATE("indeterminate"),
  ;

  public companion object {
    public fun fromWireValue(value: String): TicketState? = entries.firstOrNull { it.wireValue == value }
  }
}

/**
 * Content-bounded durable mutation receipt. `ticketId`, `requestId`, and `idempotencyKey` remain the
 * reconciliation identity across restart; callers must never replace them merely because a response
 * was lost. Result/error payloads are available for explicit handling but omitted from rendering.
 */
public class DurableTicket(
  public val ticketId: String,
  public val requestId: String,
  public val idempotencyKey: String,
  public val operation: String,
  public val state: TicketState,
  public val submittedAt: String,
  public val updatedAt: String,
  public val sessionId: String?,
  public val generation: Int?,
  public val links: Map<String, String>,
  public val result: JsonElement?,
  public val error: SafeApiError?,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "DurableTicket(ticketId=$ticketId, requestId=$requestId, operation=$operation, state=$state, sessionId=$sessionId, generation=$generation, result=[REDACTED], errorCode=${error?.code}, additionalFieldCount=${additionalFields.size})"
}

/**
 * Safe decoder for the neutral session API fixtures. Decode failures expose only bounded error codes
 * and field labels, never the malformed response bytes. Additive capability/ticket fields remain
 * available as JSON without being promoted to authority by this SDK layer.
 */
public object SessionApiCodec {
  private const val MAX_RESPONSE_BYTES: Int = 4 * 1_024 * 1_024
  private val json: Json = Json

  public fun decodeCapabilities(response: NeutralHttpResponse): ApiResult<HostCapabilities> =
    decodeEnvelope(response) { data ->
      val knownFields = setOf("apiVersion", "transports", "rpcSubprotocols", "authentication")
      HostCapabilities(
        apiVersion = data.requiredString("apiVersion"),
        transports = data.requiredStringSet("transports"),
        rpcSubprotocols = data.requiredStringSet("rpcSubprotocols"),
        authentication = data.requiredString("authentication"),
        additionalFields = data.without(knownFields),
      )
    }

  public fun decodeTicket(response: NeutralHttpResponse): ApiResult<DurableTicket> =
    decodeEnvelope(response) { data ->
      val stateValue = data.requiredString("state")
      val knownFields =
        setOf(
          "ticketId",
          "requestId",
          "idempotencyKey",
          "operation",
          "state",
          "submittedAt",
          "updatedAt",
          "sessionId",
          "generation",
          "links",
          "result",
          "error",
        )
      DurableTicket(
        ticketId = data.requiredString("ticketId"),
        requestId = data.requiredString("requestId"),
        idempotencyKey = data.requiredString("idempotencyKey"),
        operation = data.requiredString("operation"),
        state =
          TicketState.fromWireValue(stateValue)
            ?: throw ProtocolDecodeException("unsupported_ticket_state", "ticket state is unsupported"),
        submittedAt = data.requiredString("submittedAt"),
        updatedAt = data.requiredString("updatedAt"),
        sessionId = data.optionalString("sessionId"),
        generation = data.optionalNonNegativeInt("generation"),
        links = data.requiredStringMap("links"),
        result = data["result"].takeUnless { it == JsonNull },
        error = data["error"]?.takeUnless { it == JsonNull }?.let(::decodeError),
        additionalFields = data.without(knownFields),
      )
    }

  private fun <T> decodeEnvelope(
    response: NeutralHttpResponse,
    decodeData: (JsonObject) -> T,
  ): ApiResult<T> {
    val root = decodeObject(response.bodyBytes(), MAX_RESPONSE_BYTES, "HTTP response")
    val apiVersion = root.requiredString("apiVersion")
    if (apiVersion != "1.0") {
      throw ProtocolDecodeException("unsupported_api_version", "HTTP response API version is unsupported")
    }
    val requestId = root.requiredString("requestId")
    val hostInstanceId = root.requiredString("hostInstanceId")
    return when (root.requiredBoolean("ok")) {
      true -> {
        val data =
          root["data"] as? JsonObject
            ?: throw ProtocolDecodeException("missing_data", "successful HTTP response is missing data")
        ApiResult.Success(requestId, hostInstanceId, decodeData(data))
      }

      false -> {
        val error =
          root["error"]?.let(::decodeError)
            ?: throw ProtocolDecodeException("missing_error", "failed HTTP response is missing safe error metadata")
        ApiResult.Failure(requestId, hostInstanceId, error)
      }
    }
  }

  internal fun decodeObject(
    bytes: ByteArray,
    maxBytes: Int,
    label: String,
  ): JsonObject {
    if (bytes.size > maxBytes) {
      throw ProtocolDecodeException("message_too_large", "$label exceeds the negotiated safety bound")
    }
    val text =
      try {
        StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString()
      } catch (_: Exception) {
        throw ProtocolDecodeException("invalid_utf8", "$label is not valid UTF-8")
      }
    val element =
      try {
        json.parseToJsonElement(text)
      } catch (_: Exception) {
        throw ProtocolDecodeException("invalid_json", "$label is not valid JSON")
      }
    return element as? JsonObject
      ?: throw ProtocolDecodeException("invalid_shape", "$label must be a JSON object")
  }

  private fun decodeError(element: JsonElement): SafeApiError {
    val error =
      element as? JsonObject
        ?: throw ProtocolDecodeException("invalid_error", "safe error metadata must be an object")
    val details =
      when (val elementDetails = error["details"]) {
        null, JsonNull -> JsonObject(emptyMap())
        is JsonObject -> elementDetails
        else -> throw ProtocolDecodeException("invalid_error", "safe error details must be an object")
      }
    return SafeApiError(
      code = error.requiredString("code"),
      message = error.requiredString("message"),
      retryable = error.requiredBoolean("retryable"),
      details = details,
    )
  }
}

internal fun JsonObject.requiredString(name: String): String {
  val value = (this[name] as? JsonPrimitive)?.contentOrNull
  if (value == null || value.isEmpty() || value.length > 8_192) {
    throw ProtocolDecodeException("invalid_field", "required string field is missing or invalid: $name")
  }
  return value
}

internal fun JsonObject.optionalString(name: String): String? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  return (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= 8_192 }
    ?: throw ProtocolDecodeException("invalid_field", "optional string field is invalid: $name")
}

internal fun JsonObject.requiredBoolean(name: String): Boolean =
  (this[name] as? JsonPrimitive)?.booleanOrNull
    ?: throw ProtocolDecodeException("invalid_field", "required boolean field is missing or invalid: $name")

internal fun JsonObject.optionalNonNegativeInt(name: String): Int? {
  val element = this[name] ?: return null
  if (element == JsonNull) return null
  val value =
    (element as? JsonPrimitive)?.intOrNull
      ?: throw ProtocolDecodeException("invalid_field", "optional integer field is invalid: $name")
  if (value < 0) {
    throw ProtocolDecodeException("invalid_field", "optional integer field is negative: $name")
  }
  return value
}

internal fun JsonObject.requiredStringSet(name: String): Set<String> {
  val values =
    this[name] as? JsonArray
      ?: throw ProtocolDecodeException("invalid_field", "required string array is missing or invalid: $name")
  if (values.size > 1_024) {
    throw ProtocolDecodeException("invalid_field", "required string array is too large: $name")
  }
  return values.mapTo(linkedSetOf()) { element ->
    (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= 256 }
      ?: throw ProtocolDecodeException("invalid_field", "string array member is invalid: $name")
  }
}

internal fun JsonObject.requiredStringMap(name: String): Map<String, String> {
  val values =
    this[name] as? JsonObject
      ?: throw ProtocolDecodeException("invalid_field", "required string map is missing or invalid: $name")
  if (values.size > 128) {
    throw ProtocolDecodeException("invalid_field", "required string map is too large: $name")
  }
  return values.mapValuesTo(linkedMapOf()) { (_, element) ->
    (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= 4_096 }
      ?: throw ProtocolDecodeException("invalid_field", "string map member is invalid: $name")
  }
}

internal fun JsonObject.without(names: Set<String>): JsonObject = JsonObject(filterKeys { it !in names })
