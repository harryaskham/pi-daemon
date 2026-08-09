package com.harryaskham.pidroid.sdk.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** Stable caller-owned identity for one durable request. Never regenerate it after admission. */
public data class DurableRequestIdentity(
  public val requestId: String,
  public val idempotencyKey: String,
) {
  init {
    requireBoundedIdentity(requestId, "request ID", 128)
    requireBoundedIdentity(idempotencyKey, "idempotency key", 512)
  }

  override fun toString(): String = "DurableRequestIdentity(requestId=$requestId, idempotencyKey=[REDACTED])"
}

public enum class ConfiguredSessionPersistence(
  public val wireValue: String,
) {
  PERSISTENT("persistent"),
  MEMORY("memory"),
  ;

  internal val targetMode: String
    get() = if (this == PERSISTENT) "new" else "memory"

  public companion object {
    public fun fromWireValue(value: String): ConfiguredSessionPersistence? = entries.firstOrNull { it.wireValue == value }
  }
}

/**
 * Browser-safe create defaults advertised by the daemon. The configured cwd is server authority;
 * this SDK intentionally provides no cwd override when materializing [configuredCreateBody].
 */
public class ConfiguredSessionDefaults internal constructor(
  public val cwd: String,
  public val persistence: ConfiguredSessionPersistence,
  public val model: JsonObject?,
  public val tools: JsonObject,
  public val resources: JsonObject,
  public val isolation: JsonObject,
  public val cwdSource: String,
  public val modelSource: String,
  public val authoritySource: String,
) {
  init {
    require(cwd.isNotEmpty() && cwd.length <= 4_096 && '\r' !in cwd && '\n' !in cwd && '\u0000' !in cwd) {
      "configured cwd must be a server-authoritative bounded path"
    }
    require(cwdSource == "configured") { "configured cwd must carry configured server authority" }
  }

  override fun toString(): String =
    "ConfiguredSessionDefaults(cwd=[SERVER-CONFIGURED], persistence=$persistence, model=${model != null}, authoritySource=$authoritySource)"
}

public class DashboardTuiCapability internal constructor(
  public val available: Boolean,
  public val subprotocol: String,
  public val unavailableReason: String?,
) {
  override fun toString(): String =
    "DashboardTuiCapability(available=$available, subprotocol=$subprotocol, unavailableReason=$unavailableReason)"
}

public class DashboardCapabilities internal constructor(
  public val apiVersion: String,
  public val authentication: String,
  public val resources: Set<String>,
  public val tui: DashboardTuiCapability,
  public val configuredSessionDefaults: ConfiguredSessionDefaults?,
  public val limits: Map<String, Int>,
  public val additionalFields: JsonObject,
) {
  public fun requireResource(name: String) {
    if (name !in resources) {
      throw CapabilityUnavailableException("dashboard_resource_unavailable", "dashboard resource is not advertised: $name")
    }
  }

  override fun toString(): String =
    "DashboardCapabilities(apiVersion=$apiVersion, authentication=$authentication, resources=$resources, tui=$tui, configuredDefaults=${configuredSessionDefaults != null}, limitCount=${limits.size}, additionalFieldCount=${additionalFields.size})"
}

public class CapabilityUnavailableException(
  public val code: String,
  message: String,
) : IllegalStateException(message)

public enum class ManagedSessionResidency(
  public val wireValue: String,
) {
  RESIDENT("resident"),
  DORMANT("dormant"),
  ;

  public companion object {
    public fun fromWireValue(value: String): ManagedSessionResidency? = entries.firstOrNull { it.wireValue == value }
  }
}

/** Safe retained session resource. Raw environment values are never represented. */
public class ManagedSessionResource internal constructor(
  public val key: SessionKey,
  public val name: String?,
  public val revision: Int,
  public val residency: ManagedSessionResidency,
  public val state: String,
  public val createdAt: String,
  public val updatedAt: String,
  public val lastUsedAt: String,
  public val spec: JsonObject,
  public val environment: JsonObject,
  public val recovery: JsonObject?,
  public val links: Map<String, String>,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "ManagedSessionResource(sessionId=${key.sessionId}, generation=${key.generation}, revision=$revision, residency=$residency, state=$state, spec=[REDACTED], environmentKeys=${environment.size}, recovery=${recovery != null})"
}

public class ManagedSessionPage internal constructor(
  public val sessions: List<ManagedSessionResource>,
  public val nextCursor: String?,
) {
  override fun toString(): String = "ManagedSessionPage(sessions=${sessions.size}, nextCursor=${nextCursor != null})"
}

public class DashboardManagedSession internal constructor(
  public val key: SessionKey,
  public val name: String?,
  public val revision: Int,
  public val residency: ManagedSessionResidency,
  public val state: String,
  public val recovery: JsonObject?,
) {
  override fun toString(): String =
    "DashboardManagedSession(sessionId=${key.sessionId}, generation=${key.generation}, revision=$revision, residency=$residency, state=$state, recovery=${recovery != null})"
}

public enum class DashboardActivationMode(
  public val wireValue: String,
) {
  REUSE("reuse"),
  DIRECT("direct"),
  FORK("fork"),
  PREVIEW_ONLY("preview-only"),
  ;

  public companion object {
    public fun fromWireValue(value: String): DashboardActivationMode? = entries.firstOrNull { it.wireValue == value }
  }
}

public class DashboardInventoryActivation internal constructor(
  public val eligible: Boolean,
  public val modes: Set<DashboardActivationMode>,
  public val reasonCode: String?,
) {
  override fun toString(): String = "DashboardInventoryActivation(eligible=$eligible, modes=$modes, reasonCode=$reasonCode)"
}

public class DashboardSessionPresence internal constructor(
  public val runtime: String,
  public val activation: String,
  public val focusedPaneCount: Int,
  public val lastSettledCursor: String?,
  public val seenCursor: String?,
  public val unread: Boolean,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "DashboardSessionPresence(runtime=$runtime, activation=$activation, focusedPaneCount=$focusedPaneCount, cursor=[REDACTED], unread=$unread)"
}

public class DashboardInventoryRecord internal constructor(
  public val inventoryId: String,
  public val sourceKind: String,
  public val title: String,
  public val cwdBasename: String?,
  public val projectLabel: String?,
  public val piSessionId: String?,
  public val createdAt: String,
  public val modifiedAt: String,
  public val activityAt: String?,
  public val messageCount: Int,
  public val entryCount: Int?,
  public val toolCallCount: Int?,
  public val currentLeafId: String?,
  public val managed: DashboardManagedSession?,
  public val activation: DashboardInventoryActivation,
  public val presence: DashboardSessionPresence,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "DashboardInventoryRecord(inventoryId=$inventoryId, sourceKind=$sourceKind, title=[REDACTED], managed=${managed?.key}, activation=$activation, presence=$presence)"
}

public class DashboardInventoryIndex internal constructor(
  public val formatVersion: Int,
  public val loadedAt: String,
  public val reconciledAt: String?,
  public val stale: Boolean,
  public val reconciling: Boolean,
)

public class DashboardInventoryPage internal constructor(
  public val sessions: List<DashboardInventoryRecord>,
  public val nextCursor: String?,
  public val index: DashboardInventoryIndex,
) {
  override fun toString(): String =
    "DashboardInventoryPage(sessions=${sessions.size}, nextCursor=${nextCursor != null}, stale=${index.stale}, reconciling=${index.reconciling})"
}

public class DashboardSessionInfo internal constructor(
  public val session: DashboardInventoryRecord,
  public val cwd: String,
  public val sourceFingerprint: String?,
  public val ownershipMode: String,
  public val diagnostics: List<SafeApiError>,
  public val runtime: JsonObject?,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "DashboardSessionInfo(inventoryId=${session.inventoryId}, cwd=[REDACTED], sourceFingerprint=${sourceFingerprint != null}, ownershipMode=$ownershipMode, diagnostics=${diagnostics.size}, runtime=${runtime != null})"
}

public enum class TranscriptAvailabilityState(
  public val wireValue: String,
) {
  AVAILABLE("available"),
  UNAVAILABLE("unavailable"),
  ;

  public companion object {
    public fun fromWireValue(value: String): TranscriptAvailabilityState? = entries.firstOrNull { it.wireValue == value }
  }
}

public enum class TranscriptFreshnessState(
  public val wireValue: String,
) {
  CURRENT("current"),
  UNAVAILABLE("unavailable"),
  ;

  public companion object {
    public fun fromWireValue(value: String): TranscriptFreshnessState? = entries.firstOrNull { it.wireValue == value }
  }
}

/**
 * Bounded transcript projection plus the authority facts required before observer attachment.
 * Records remain additive JSON for projection by sdk-session-ui and are redacted from rendering.
 */
public class DashboardTranscript internal constructor(
  public val inventoryId: String,
  public val piSessionId: String?,
  public val managedSession: SessionKey?,
  public val currentLeafId: String?,
  public val sourceFingerprint: String?,
  public val records: JsonArray,
  public val olderCursor: String?,
  public val newerCursor: String?,
  public val availability: TranscriptAvailabilityState,
  public val availabilityReasonCode: String?,
  public val availabilityRetryable: Boolean,
  public val observerAttachAllowed: Boolean,
  public val freshness: TranscriptFreshnessState,
  public val quarantine: JsonObject?,
  public val additionalFields: JsonObject,
) {
  /** Exact identity suitable for read-only attach, or null when preview authority forbids it. */
  public val observerSession: SessionKey?
    get() =
      managedSession.takeIf {
        availability == TranscriptAvailabilityState.AVAILABLE &&
          freshness == TranscriptFreshnessState.CURRENT &&
          observerAttachAllowed &&
          quarantine == null
      }

  override fun toString(): String =
    "DashboardTranscript(inventoryId=$inventoryId, managedSession=$managedSession, records=${records.size}, availability=$availability, freshness=$freshness, observerAttachAllowed=$observerAttachAllowed, content=[REDACTED])"
}

public class DashboardActivationTicket internal constructor(
  public val ticketId: String,
  public val requestId: String,
  public val idempotencyKey: String,
  public val inventoryId: String,
  public val mode: DashboardActivationMode,
  public val state: TicketState,
  public val submittedAt: String,
  public val updatedAt: String,
  public val managedSession: SessionKey?,
  public val error: SafeApiError?,
  public val additionalFields: JsonObject,
) {
  override fun toString(): String =
    "DashboardActivationTicket(ticketId=$ticketId, requestId=$requestId, inventoryId=$inventoryId, mode=$mode, state=$state, managedSession=$managedSession, errorCode=${error?.code})"
}

public sealed interface SessionAdoption {
  public class Existing(
    public val inventoryId: String,
    public val session: ManagedSessionResource,
  ) : SessionAdoption {
    override fun toString(): String = "SessionAdoption.Existing(inventoryId=$inventoryId, session=${session.key})"
  }

  public class Activating(
    public val ticket: DashboardActivationTicket,
  ) : SessionAdoption {
    override fun toString(): String = "SessionAdoption.Activating(ticket=$ticket)"
  }
}

/** Evidence-backed terminal result for an already-indeterminate ticket. */
public sealed interface TicketReconciliation {
  public val requestId: String
  public val piEntryIds: List<String>

  public class Succeeded(
    override val requestId: String,
    override val piEntryIds: List<String>,
  ) : TicketReconciliation

  public class Failed(
    override val requestId: String,
    override val piEntryIds: List<String>,
    public val code: String,
    public val retryable: Boolean,
  ) : TicketReconciliation
}

/** Strict decoders/encoders for the REST lifecycle used by Pi Droid. */
public object SessionLifecycleCodec {
  private const val MAX_SESSION_PAGE_ITEMS: Int = 100
  private const val MAX_TRANSCRIPT_RECORDS: Int = 200

  public fun decodeDashboardCapabilities(response: NeutralHttpResponse): ApiResult<DashboardCapabilities> =
    SessionApiCodec.decodeEnvelope(response) { data -> decodeDashboardCapabilitiesData(data) }

  public fun decodeSession(response: NeutralHttpResponse): ApiResult<ManagedSessionResource> =
    SessionApiCodec.decodeEnvelope(response, ::decodeSessionData)

  public fun decodeSessionPage(response: NeutralHttpResponse): ApiResult<ManagedSessionPage> =
    SessionApiCodec.decodeEnvelope(response) { data ->
      val sessions =
        data
          .lifecycleRequiredArray(
            "sessions",
            MAX_SESSION_PAGE_ITEMS,
          ).map { decodeSessionData(it.lifecycleObject("session")) }
      ManagedSessionPage(sessions, data.lifecycleOptionalString("nextCursor", 1_024))
    }

  public fun decodeInventory(response: NeutralHttpResponse): ApiResult<DashboardInventoryPage> =
    SessionApiCodec.decodeEnvelope(response) { data ->
      val sessions =
        data.lifecycleRequiredArray("sessions", MAX_SESSION_PAGE_ITEMS).map {
          decodeInventoryRecord(it.lifecycleObject("inventory session"))
        }
      val index = data.lifecycleRequiredObject("index")
      DashboardInventoryPage(
        sessions = sessions,
        nextCursor = data.lifecycleOptionalString("nextCursor", 1_024),
        index =
          DashboardInventoryIndex(
            formatVersion = index.lifecycleRequiredNonNegativeInt("formatVersion"),
            loadedAt = index.requiredString("loadedAt"),
            reconciledAt = index.optionalString("reconciledAt"),
            stale = index.requiredBoolean("stale"),
            reconciling = index.requiredBoolean("reconciling"),
          ),
      )
    }

  public fun decodeSessionInfo(response: NeutralHttpResponse): ApiResult<DashboardSessionInfo> =
    SessionApiCodec.decodeEnvelope(response) { data ->
      val source = data.lifecycleRequiredObject("source")
      val fingerprint = (source["fingerprint"] as? JsonObject)?.optionalString("value")
      val ownership = data.lifecycleRequiredObject("ownership")
      val diagnostics =
        data.lifecycleRequiredArray("diagnostics", 128).map { element ->
          val diagnostic = element.lifecycleObject("diagnostic")
          SafeApiError(
            code = diagnostic.requiredString("code"),
            message = diagnostic.requiredString("message"),
            retryable = diagnostic.requiredBoolean("retryable"),
            details = JsonObject(emptyMap()),
          )
        }
      val infoFields = setOf("cwd", "source", "ownership", "diagnostics", "runtime")
      DashboardSessionInfo(
        session = decodeInventoryRecord(data),
        cwd = data.lifecycleRequiredString("cwd", 4_096),
        sourceFingerprint = fingerprint,
        ownershipMode = ownership.requiredString("mode"),
        diagnostics = diagnostics,
        runtime = data["runtime"].lifecycleOptionalObject("runtime"),
        additionalFields = data.without(inventoryKnownFields + infoFields),
      )
    }

  public fun decodeTranscript(response: NeutralHttpResponse): ApiResult<DashboardTranscript> =
    SessionApiCodec.decodeEnvelope(response) { data ->
      val availability = data.lifecycleRequiredObject("availability")
      val freshness = data.lifecycleRequiredObject("freshness")
      val records = data.lifecycleRequiredArray("records", MAX_TRANSCRIPT_RECORDS)
      val managed = data["managedSession"].lifecycleOptionalObject("managedSession")
      val availabilityState =
        TranscriptAvailabilityState.fromWireValue(availability.requiredString("state"))
          ?: throw ProtocolDecodeException("unsupported_transcript_availability", "transcript availability is unsupported")
      val freshnessState =
        TranscriptFreshnessState.fromWireValue(freshness.requiredString("state"))
          ?: throw ProtocolDecodeException("unsupported_transcript_freshness", "transcript freshness is unsupported")
      if (availabilityState == TranscriptAvailabilityState.UNAVAILABLE && records.isNotEmpty()) {
        throw ProtocolDecodeException("invalid_transcript", "unavailable transcript cannot contain records")
      }
      DashboardTranscript(
        inventoryId = data.lifecycleRequiredString("inventoryId", 256),
        piSessionId = data.lifecycleOptionalString("piSessionId", 256),
        managedSession =
          managed?.let {
            SessionKey(it.lifecycleRequiredString("sessionId", 128), it.lifecycleRequiredNonNegativeInt("generation"))
          },
        currentLeafId = data.lifecycleOptionalString("currentLeafId", 256),
        sourceFingerprint = data.lifecycleOptionalString("sourceFingerprint", 512),
        records = records,
        olderCursor = data.lifecycleOptionalString("olderCursor", 1_024),
        newerCursor = data.lifecycleOptionalString("newerCursor", 1_024),
        availability = availabilityState,
        availabilityReasonCode = availability.optionalString("reasonCode"),
        availabilityRetryable = availability.requiredBoolean("retryable"),
        observerAttachAllowed = availability.requiredBoolean("observerAttachAllowed"),
        freshness = freshnessState,
        quarantine = data["quarantine"].lifecycleOptionalObject("quarantine"),
        additionalFields = data.without(transcriptKnownFields),
      )
    }

  public fun decodeActivationTicket(response: NeutralHttpResponse): ApiResult<DashboardActivationTicket> =
    SessionApiCodec.decodeEnvelope(response) { data ->
      val state = data.requiredString("state")
      val mode = data.requiredString("mode")
      val managed = data["managedSession"].lifecycleOptionalObject("managedSession")
      DashboardActivationTicket(
        ticketId = data.lifecycleRequiredString("ticketId", 256),
        requestId = data.lifecycleRequiredString("requestId", 128),
        idempotencyKey = data.lifecycleRequiredString("idempotencyKey", 512),
        inventoryId = data.lifecycleRequiredString("inventoryId", 256),
        mode =
          DashboardActivationMode.fromWireValue(mode)
            ?: throw ProtocolDecodeException("unsupported_activation_mode", "activation mode is unsupported"),
        state =
          TicketState.fromWireValue(state)
            ?: throw ProtocolDecodeException("unsupported_ticket_state", "activation ticket state is unsupported"),
        submittedAt = data.requiredString("submittedAt"),
        updatedAt = data.requiredString("updatedAt"),
        managedSession =
          managed?.let {
            SessionKey(it.lifecycleRequiredString("sessionId", 128), it.lifecycleRequiredNonNegativeInt("generation"))
          },
        error = data["error"]?.takeUnless { it == JsonNull }?.let(SessionApiCodec::decodeError),
        additionalFields = data.without(activationTicketKnownFields),
      )
    }

  public fun configuredCreateBody(
    defaults: ConfiguredSessionDefaults,
    identity: DurableRequestIdentity,
    sessionId: String? = null,
    name: String? = null,
  ): ByteArray {
    sessionId?.let { requireBoundedIdentity(it, "session ID", 128) }
    name?.let { requireBoundedIdentity(it, "session name", 128) }
    val spec =
      linkedMapOf<String, JsonElement>(
        "cwd" to JsonPrimitive(defaults.cwd),
        "target" to JsonObject(mapOf("mode" to JsonPrimitive(defaults.persistence.targetMode))),
      )
    name?.let { spec["name"] = JsonPrimitive(it) }
    defaults.model?.let { spec["model"] = it }
    spec["tools"] = defaults.tools
    spec["resources"] = defaults.resources
    spec["isolation"] = defaults.isolation
    val request = linkedMapOf<String, JsonElement>("requestId" to JsonPrimitive(identity.requestId))
    sessionId?.let { request["sessionId"] = JsonPrimitive(it) }
    request["spec"] = JsonObject(spec)
    val body = JsonObject(request).toString().encodeToByteArray()
    require(body.size <= 1_048_576) { "configured create request exceeds the protocol body bound" }
    return body
  }

  public fun activationBody(
    identity: DurableRequestIdentity,
    expectedFingerprint: String? = null,
  ): ByteArray {
    expectedFingerprint?.let { requireBoundedIdentity(it, "source fingerprint", 512) }
    val body =
      linkedMapOf<String, JsonElement>(
        "requestId" to JsonPrimitive(identity.requestId),
        "idempotencyKey" to JsonPrimitive(identity.idempotencyKey),
        "mode" to JsonPrimitive("reuse"),
      )
    expectedFingerprint?.let { body["expectedFingerprint"] = JsonPrimitive(it) }
    return JsonObject(body).toString().encodeToByteArray()
  }

  public fun reconciliationBody(reconciliation: TicketReconciliation): ByteArray {
    requireBoundedIdentity(reconciliation.requestId, "request ID", 128)
    require(reconciliation.piEntryIds.isNotEmpty() && reconciliation.piEntryIds.size <= 256) {
      "reconciliation requires one to 256 retained Pi entry IDs"
    }
    reconciliation.piEntryIds.forEach { requireBoundedIdentity(it, "Pi entry ID", 256) }
    val body =
      linkedMapOf<String, JsonElement>(
        "requestId" to JsonPrimitive(reconciliation.requestId),
        "state" to JsonPrimitive(if (reconciliation is TicketReconciliation.Succeeded) "succeeded" else "failed"),
        "evidence" to JsonObject(mapOf("piEntryIds" to JsonArray(reconciliation.piEntryIds.map(::JsonPrimitive)))),
      )
    if (reconciliation is TicketReconciliation.Failed) {
      requireBoundedIdentity(reconciliation.code, "reconciliation error code", 128)
      body["error"] =
        JsonObject(
          mapOf(
            "code" to JsonPrimitive(reconciliation.code),
            "retryable" to JsonPrimitive(reconciliation.retryable),
          ),
        )
    }
    return JsonObject(body).toString().encodeToByteArray()
  }

  private fun decodeDashboardCapabilitiesData(data: JsonObject): DashboardCapabilities {
    val resourcesObject = data.lifecycleRequiredObject("resources")
    val resources = resourcesObject.filterValues { (it as? JsonPrimitive)?.booleanOrNull == true }.keys
    val presentations = data.lifecycleRequiredObject("presentations")
    val tui = presentations.lifecycleRequiredObject("tui")
    val defaults = data["sessionDefaults"].lifecycleOptionalObject("sessionDefaults")?.let(::decodeDefaults)
    val limits = data.lifecycleRequiredObject("limits")
    if (limits.size > 256) throw ProtocolDecodeException("invalid_field", "dashboard limits are too large")
    val decodedLimits =
      limits.mapValuesTo(linkedMapOf()) { (name, value) ->
        (value as? JsonPrimitive)?.intOrNull?.takeIf { it >= 0 }
          ?: throw ProtocolDecodeException("invalid_field", "dashboard limit is invalid: $name")
      }
    return DashboardCapabilities(
      apiVersion = data.requiredString("apiVersion"),
      authentication = data.requiredString("authentication"),
      resources = resources,
      tui =
        DashboardTuiCapability(
          available = tui.requiredBoolean("available"),
          subprotocol = tui.requiredString("subprotocol"),
          unavailableReason = tui.optionalString("unavailableReason"),
        ),
      configuredSessionDefaults = defaults,
      limits = decodedLimits,
      additionalFields = data.without(setOf("apiVersion", "authentication", "resources", "presentations", "sessionDefaults", "limits")),
    )
  }

  private fun decodeDefaults(value: JsonObject): ConfiguredSessionDefaults {
    val spec = value.lifecycleRequiredObject("spec")
    val sources = value.lifecycleRequiredObject("sources")
    val persistenceValue = spec.lifecycleRequiredString("persistence", 32)
    val cwdSource = sources.lifecycleRequiredString("cwd", 64)
    if (cwdSource != "configured") {
      throw ProtocolDecodeException(
        "unsupported_cwd_authority",
        "configured session cwd does not carry configured server authority",
      )
    }
    return ConfiguredSessionDefaults(
      cwd = spec.lifecycleRequiredString("cwd", 4_096),
      persistence =
        ConfiguredSessionPersistence.fromWireValue(persistenceValue)
          ?: throw ProtocolDecodeException("unsupported_persistence", "configured session persistence is unsupported"),
      model = spec["model"].lifecycleOptionalObject("model"),
      tools = spec.lifecycleRequiredObject("tools"),
      resources = spec.lifecycleRequiredObject("resources"),
      isolation = spec.lifecycleRequiredObject("isolation"),
      cwdSource = cwdSource,
      modelSource = sources.lifecycleRequiredString("model", 64),
      authoritySource = sources.lifecycleRequiredString("authority", 64),
    )
  }

  private fun decodeSessionData(data: JsonObject): ManagedSessionResource {
    val residencyValue = data.requiredString("residency")
    val key = SessionKey(data.lifecycleRequiredString("sessionId", 128), data.lifecycleRequiredNonNegativeInt("generation"))
    return ManagedSessionResource(
      key = key,
      name = data.lifecycleOptionalString("name", 128),
      revision = data.lifecycleRequiredNonNegativeInt("revision"),
      residency =
        ManagedSessionResidency.fromWireValue(residencyValue)
          ?: throw ProtocolDecodeException("unsupported_session_residency", "session residency is unsupported"),
      state = data.lifecycleRequiredString("state", 64),
      createdAt = data.requiredString("createdAt"),
      updatedAt = data.requiredString("updatedAt"),
      lastUsedAt = data.requiredString("lastUsedAt"),
      spec = data.lifecycleRequiredObject("spec"),
      environment = data.lifecycleRequiredObject("environment"),
      recovery = data["recovery"].lifecycleOptionalObject("recovery"),
      links = data.requiredStringMap("links"),
      additionalFields = data.without(sessionKnownFields),
    )
  }

  private fun decodeInventoryRecord(data: JsonObject): DashboardInventoryRecord {
    val managed = data["managed"].lifecycleOptionalObject("managed")
    val activation = data.lifecycleRequiredObject("activation")
    val modes =
      activation.lifecycleRequiredArray("modes", 8).mapTo(linkedSetOf()) { element ->
        val value =
          (element as? JsonPrimitive)?.content
            ?: throw ProtocolDecodeException("invalid_field", "activation mode is invalid")
        DashboardActivationMode.fromWireValue(value)
          ?: throw ProtocolDecodeException("unsupported_activation_mode", "activation mode is unsupported")
      }
    val presence = data.lifecycleRequiredObject("presence")
    return DashboardInventoryRecord(
      inventoryId = data.lifecycleRequiredString("inventoryId", 256),
      sourceKind = data.lifecycleRequiredString("sourceKind", 64),
      title = data.lifecycleRequiredString("title", 8_192),
      cwdBasename = data.lifecycleOptionalString("cwdBasename", 512),
      projectLabel = data.lifecycleOptionalString("projectLabel", 512),
      piSessionId = data.lifecycleOptionalString("piSessionId", 256),
      createdAt = data.requiredString("createdAt"),
      modifiedAt = data.requiredString("modifiedAt"),
      activityAt = data.optionalString("activityAt"),
      messageCount = data.lifecycleRequiredNonNegativeInt("messageCount"),
      entryCount = data.optionalNonNegativeInt("entryCount"),
      toolCallCount = data.optionalNonNegativeInt("toolCallCount"),
      currentLeafId = data.lifecycleOptionalString("currentLeafId", 256),
      managed =
        managed?.let {
          val residency = it.requiredString("residency")
          DashboardManagedSession(
            key = SessionKey(it.lifecycleRequiredString("sessionId", 128), it.lifecycleRequiredNonNegativeInt("generation")),
            name = it.lifecycleOptionalString("name", 128),
            revision = it.lifecycleRequiredNonNegativeInt("revision"),
            residency =
              ManagedSessionResidency.fromWireValue(residency)
                ?: throw ProtocolDecodeException("unsupported_session_residency", "managed session residency is unsupported"),
            state = it.lifecycleRequiredString("state", 64),
            recovery = it["recovery"].lifecycleOptionalObject("recovery"),
          )
        },
      activation =
        DashboardInventoryActivation(
          eligible = activation.requiredBoolean("eligible"),
          modes = modes,
          reasonCode = activation.optionalString("reasonCode"),
        ),
      presence =
        DashboardSessionPresence(
          runtime = presence.lifecycleRequiredString("runtime", 64),
          activation = presence.lifecycleRequiredString("activation", 64),
          focusedPaneCount = presence.lifecycleRequiredNonNegativeInt("focusedPaneCount"),
          lastSettledCursor = presence.lifecycleOptionalString("lastSettledCursor", 1_024),
          seenCursor = presence.lifecycleOptionalString("seenCursor", 1_024),
          unread = presence.requiredBoolean("unread"),
          additionalFields =
            presence.without(
              setOf("runtime", "activation", "focusedPaneCount", "lastSettledCursor", "seenCursor", "unread"),
            ),
        ),
      additionalFields = data.without(inventoryKnownFields),
    )
  }

  private val sessionKnownFields: Set<String> =
    setOf(
      "sessionId",
      "name",
      "generation",
      "revision",
      "residency",
      "state",
      "createdAt",
      "updatedAt",
      "lastUsedAt",
      "spec",
      "environment",
      "recovery",
      "links",
    )
  private val inventoryKnownFields: Set<String> =
    setOf(
      "inventoryId",
      "sourceKind",
      "title",
      "cwdBasename",
      "projectLabel",
      "piSessionId",
      "parentPiSessionId",
      "createdAt",
      "modifiedAt",
      "activityAt",
      "messageCount",
      "entryCount",
      "toolCallCount",
      "currentLeafId",
      "managed",
      "activation",
      "presence",
    )
  private val transcriptKnownFields: Set<String> =
    setOf(
      "inventoryId",
      "piSessionId",
      "managedSession",
      "currentLeafId",
      "sourceFingerprint",
      "records",
      "order",
      "olderCursor",
      "newerCursor",
      "projection",
      "availability",
      "freshness",
      "quarantine",
      "hydration",
    )
  private val activationTicketKnownFields: Set<String> =
    setOf("ticketId", "requestId", "idempotencyKey", "inventoryId", "mode", "state", "submittedAt", "updatedAt", "managedSession", "error")
}

private fun requireBoundedIdentity(
  value: String,
  label: String,
  maxLength: Int,
) {
  require(value.isNotEmpty() && value.length <= maxLength && '\r' !in value && '\n' !in value && '\u0000' !in value) {
    "$label must be present and bounded"
  }
}

private fun JsonObject.lifecycleRequiredString(
  name: String,
  maxLength: Int,
): String =
  requiredString(name).takeIf { it.length <= maxLength }
    ?: throw ProtocolDecodeException("invalid_field", "required string field is too long: $name")

private fun JsonObject.lifecycleOptionalString(
  name: String,
  maxLength: Int,
): String? =
  optionalString(name)?.takeIf { it.length <= maxLength }
    ?: if (this[name] == null ||
      this[name] == JsonNull
    ) {
      null
    } else {
      throw ProtocolDecodeException("invalid_field", "optional string field is too long: $name")
    }

private fun JsonObject.lifecycleRequiredObject(name: String): JsonObject =
  this[name] as? JsonObject
    ?: throw ProtocolDecodeException("invalid_field", "required object field is missing or invalid: $name")

private fun JsonElement?.lifecycleOptionalObject(name: String): JsonObject? =
  when (this) {
    null, JsonNull -> null
    is JsonObject -> this
    else -> throw ProtocolDecodeException("invalid_field", "optional object field is invalid: $name")
  }

private fun JsonElement.lifecycleObject(label: String): JsonObject =
  this as? JsonObject
    ?: throw ProtocolDecodeException("invalid_field", "$label must be an object")

private fun JsonObject.lifecycleRequiredArray(
  name: String,
  maximum: Int,
): JsonArray {
  val value =
    this[name] as? JsonArray
      ?: throw ProtocolDecodeException("invalid_field", "required array field is missing or invalid: $name")
  if (value.size > maximum) throw ProtocolDecodeException("invalid_field", "required array field is too large: $name")
  return value
}

private fun JsonObject.lifecycleRequiredNonNegativeInt(name: String): Int {
  val value =
    (this[name] as? JsonPrimitive)?.intOrNull
      ?: throw ProtocolDecodeException("invalid_field", "required integer field is missing or invalid: $name")
  if (value < 0) throw ProtocolDecodeException("invalid_field", "required integer field is negative: $name")
  return value
}
