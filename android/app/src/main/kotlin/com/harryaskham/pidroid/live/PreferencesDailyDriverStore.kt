package com.harryaskham.pidroid.live

import android.content.Context
import android.util.AtomicFile
import com.harryaskham.pidroid.sdk.core.HostId
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.File

/** SharedPreferences persistence for content-free daily-driver navigation and request identities. */
public class PreferencesDailyDriverStore(
  context: Context,
) : DailyDriverStore {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val interactiveResume = AtomicFile(File(context.noBackupFilesDir, RESUME_FILE))
  private val resumeMutex = Mutex()
  private val json = Json

  override suspend fun readSelectedInventory(hostId: HostId): String? =
    selections()[hostId.value]
      ?.let { it as? JsonPrimitive }
      ?.contentOrNull
      ?.takeIf(::validOpaqueId)

  override suspend fun writeSelectedInventory(
    hostId: HostId,
    inventoryId: String?,
  ) {
    inventoryId?.let { require(validOpaqueId(it)) { "inventory identity is invalid" } }
    val updated = selections().toMutableMap()
    if (inventoryId == null) updated.remove(hostId.value) else updated[hostId.value] = JsonPrimitive(inventoryId)
    require(updated.size <= MAX_HOSTS) { "daily-driver selection count exceeds host bound" }
    commit(SELECTIONS_KEY, JsonObject(updated).toString())
  }

  override suspend fun readActionBookmark(): LiveSessionActionBookmark? {
    val encoded = preferences.getString(ACTION_KEY, null) ?: return null
    if (encoded.length > MAX_ACTION_CHARS) return null
    return runCatching {
      val root = json.parseToJsonElement(encoded) as JsonObject
      require(root.keys == ACTION_FIELDS)
      LiveSessionActionBookmark(
        hostId = HostId(root.string("hostId", 128)),
        kind = LiveSessionActionKind.valueOf(root.string("kind", 32)),
        endpoint = LiveSessionActionEndpoint.valueOf(root.string("endpoint", 32)),
        requestId = root.string("requestId", 128),
        idempotencyKey = root.string("idempotencyKey", 512),
        inventoryId = root.optionalString("inventoryId", 256),
        ticketId = root.optionalString("ticketId", 256),
      )
    }.getOrNull()
  }

  override suspend fun writeActionBookmark(bookmark: LiveSessionActionBookmark?) {
    if (bookmark == null) {
      check(preferences.edit().remove(ACTION_KEY).commit()) { "daily-driver action persistence failed" }
      return
    }
    require(validOpaqueId(bookmark.requestId) && validOpaqueId(bookmark.idempotencyKey)) {
      "daily-driver request identity is invalid"
    }
    bookmark.inventoryId?.let { require(validOpaqueId(it)) { "inventory identity is invalid" } }
    bookmark.ticketId?.let { require(validOpaqueId(it)) { "ticket identity is invalid" } }
    val encoded =
      JsonObject(
        linkedMapOf(
          "hostId" to JsonPrimitive(bookmark.hostId.value),
          "kind" to JsonPrimitive(bookmark.kind.name),
          "endpoint" to JsonPrimitive(bookmark.endpoint.name),
          "requestId" to JsonPrimitive(bookmark.requestId),
          "idempotencyKey" to JsonPrimitive(bookmark.idempotencyKey),
          "inventoryId" to JsonPrimitive(bookmark.inventoryId ?: ""),
          "ticketId" to JsonPrimitive(bookmark.ticketId ?: ""),
        ),
      ).toString()
    require(encoded.length <= MAX_ACTION_CHARS) { "daily-driver action encoding is too large" }
    commit(ACTION_KEY, encoded)
  }

  override suspend fun readInteractiveResume(): ByteArray? =
    resumeMutex.withLock {
      if (!interactiveResume.baseFile.exists()) return@withLock null
      val size = interactiveResume.baseFile.length()
      if (size !in 1..MAX_RESUME_BYTES.toLong()) {
        interactiveResume.delete()
        return@withLock null
      }
      runCatching { interactiveResume.readFully() }
        .getOrNull()
        ?.takeIf { it.size in 1..MAX_RESUME_BYTES }
    }

  override suspend fun writeInteractiveResume(encoded: ByteArray?) {
    resumeMutex.withLock {
      if (encoded == null) {
        interactiveResume.delete()
        return@withLock
      }
      require(encoded.size in 1..MAX_RESUME_BYTES) { "interactive resume snapshot size is invalid" }
      val output = interactiveResume.startWrite()
      try {
        output.write(encoded)
        interactiveResume.finishWrite(output)
      } catch (error: Throwable) {
        interactiveResume.failWrite(output)
        throw error
      }
    }
  }

  private fun selections(): JsonObject {
    val encoded = preferences.getString(SELECTIONS_KEY, null) ?: return JsonObject(emptyMap())
    if (encoded.length > MAX_SELECTION_CHARS) return JsonObject(emptyMap())
    val parsed = runCatching { json.parseToJsonElement(encoded) as? JsonObject }.getOrNull() ?: return JsonObject(emptyMap())
    return JsonObject(
      parsed.entries
        .asSequence()
        .filter { (hostId, value) ->
          runCatching { HostId(hostId) }.isSuccess &&
            (value as? JsonPrimitive)?.contentOrNull?.let(::validOpaqueId) == true
        }.take(MAX_HOSTS)
        .associate { it.toPair() },
    )
  }

  private fun commit(
    key: String,
    value: String,
  ) {
    check(preferences.edit().putString(key, value).commit()) { "daily-driver persistence failed" }
  }

  private fun JsonObject.string(
    name: String,
    maximum: Int,
  ): String =
    (this[name] as? JsonPrimitive)
      ?.contentOrNull
      ?.takeIf { it.isNotEmpty() && it.length <= maximum && '\r' !in it && '\n' !in it && '\u0000' !in it }
      ?: error("invalid daily-driver field")

  private fun JsonObject.optionalString(
    name: String,
    maximum: Int,
  ): String? {
    val value = (this[name] as? JsonPrimitive)?.contentOrNull ?: error("invalid daily-driver field")
    require(value.length <= maximum && '\r' !in value && '\n' !in value && '\u0000' !in value) {
      "invalid daily-driver field"
    }
    return value.takeIf(String::isNotEmpty)
  }

  private fun validOpaqueId(value: String): Boolean = value.length in 1..512 && value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*$"))

  private companion object {
    const val PREFERENCES: String = "pi-droid-daily-driver"
    const val SELECTIONS_KEY: String = "selected-inventory-v1"
    const val ACTION_KEY: String = "session-action-v1"
    const val MAX_HOSTS: Int = 32
    const val MAX_SELECTION_CHARS: Int = 32 * 1_024
    const val MAX_ACTION_CHARS: Int = 4 * 1_024
    const val MAX_RESUME_BYTES: Int = 1_048_576
    const val RESUME_FILE: String = "interactive-resume-v1.json"
    val ACTION_FIELDS: Set<String> =
      setOf("hostId", "kind", "endpoint", "requestId", "idempotencyKey", "inventoryId", "ticketId")
  }
}
