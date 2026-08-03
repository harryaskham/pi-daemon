package com.harryaskham.pidroid.workspace

import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

public sealed interface WorkspaceRestoreResult {
  public data class Loaded(
    public val document: WorkspaceDocument,
    public val migratedFrom: Int?,
  ) : WorkspaceRestoreResult

  public data class Quarantined(
    public val reason: String,
    public val fallback: WorkspaceDocument,
  ) : WorkspaceRestoreResult
}

public object WorkspacePersistence {
  private val json: Json =
    Json {
      classDiscriminator = "type"
      encodeDefaults = true
      explicitNulls = false
      ignoreUnknownKeys = true
      prettyPrint = true
      prettyPrintIndent = "  "
    }

  public fun encode(document: WorkspaceDocument): String = json.encodeToString(document)

  public fun restore(encoded: String): WorkspaceRestoreResult {
    val parsed =
      try {
        json.parseToJsonElement(encoded).jsonObject
      } catch (error: IllegalArgumentException) {
        return quarantine("invalid workspace JSON: ${safeMessage(error)}")
      }
    val schemaVersion =
      (parsed["schemaVersion"] as? JsonPrimitive)?.intOrNull
        ?: return quarantine("missing integer schema version")
    if (schemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION) {
      return quarantine("unsupported schema version $schemaVersion")
    }
    if (schemaVersion < 1) {
      return quarantine("unsupported schema version $schemaVersion")
    }

    val migrated =
      when (schemaVersion) {
        CURRENT_WORKSPACE_SCHEMA_VERSION -> parsed
        1 -> migrateVersionOne(parsed)
        else -> return quarantine("unsupported schema version $schemaVersion")
      }
    val decoded =
      try {
        json.decodeFromString<WorkspaceDocument>(json.encodeToString(JsonObject.serializer(), migrated))
      } catch (error: SerializationException) {
        return quarantine("invalid workspace structure: ${safeMessage(error)}")
      } catch (error: IllegalArgumentException) {
        return quarantine("invalid workspace structure: ${safeMessage(error)}")
      }

    val normalized = WorkspaceModel.normalize(decoded)
    val violations = WorkspaceModel.invariantViolations(normalized)
    if (violations.isNotEmpty()) {
      return quarantine(violations.joinToString(separator = "; "))
    }
    return WorkspaceRestoreResult.Loaded(
      document = normalized,
      migratedFrom = schemaVersion.takeUnless { it == CURRENT_WORKSPACE_SCHEMA_VERSION },
    )
  }

  private fun migrateVersionOne(source: JsonObject): JsonObject {
    val selectedTabId = (source["selectedTabId"] as? JsonPrimitive)?.contentOrNull
    val migrated = linkedMapOf<String, JsonElement>()
    source.forEach { (key, value) ->
      when (key) {
        "schemaVersion" -> migrated[key] = JsonPrimitive(CURRENT_WORKSPACE_SCHEMA_VERSION)
        "selectedTabId" -> Unit
        else -> migrated[key] = migrateVersionOneValue(value)
      }
    }
    if ("focusedTabId" !in migrated && selectedTabId != null) {
      migrated["focusedTabId"] = JsonPrimitive(selectedTabId)
    }
    return JsonObject(migrated)
  }

  private fun migrateVersionOneValue(value: JsonElement): JsonElement =
    when (value) {
      is JsonObject -> {
        JsonObject(
          value.mapValues { (key, child) ->
            if (key == "kind" && child is JsonPrimitive && child.contentOrNull == "SESSION") {
              JsonPrimitive(TargetKind.SESSION_RICH.name)
            } else {
              migrateVersionOneValue(child)
            }
          },
        )
      }

      is kotlinx.serialization.json.JsonArray -> {
        kotlinx.serialization.json.JsonArray(value.map(::migrateVersionOneValue))
      }

      else -> {
        value
      }
    }

  private fun quarantine(reason: String): WorkspaceRestoreResult.Quarantined =
    WorkspaceRestoreResult.Quarantined(
      reason = reason.take(MAX_QUARANTINE_REASON_LENGTH),
      fallback = WorkspaceDefaults.document(),
    )

  private fun safeMessage(error: Throwable): String =
    error.message
      ?.lineSequence()
      ?.firstOrNull()
      ?.take(MAX_QUARANTINE_REASON_LENGTH / 2)
      ?: error::class.simpleName.orEmpty()

  private const val MAX_QUARANTINE_REASON_LENGTH: Int = 320
}
