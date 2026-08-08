package com.harryaskham.pidroid

import android.content.Context
import com.harryaskham.pidroid.live.ExternalCanaryExpectation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes

internal class ExternalCanaryImport private constructor(
  val pairingEnvelope: String,
  val expectation: ExternalCanaryExpectation,
) {
  override fun toString(): String = "ExternalCanaryImport(pairingEnvelope=[REDACTED], expectation=$expectation)"

  companion object {
    private val exactFields =
      setOf(
        "schemaVersion",
        "pairingEnvelope",
        "expectedHostInstanceId",
        "expectedInventoryId",
        "observerAttachAllowed",
      )
    private val opaqueIdentity = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

    fun decode(encoded: ByteArray): ExternalCanaryImport {
      require(encoded.isNotEmpty() && encoded.size <= MAX_IMPORT_BYTES) { "external canary import size is invalid" }
      val root =
        Json.parseToJsonElement(encoded.decodeToString(throwOnInvalidSequence = true)) as? JsonObject
          ?: throw IllegalArgumentException("external canary import must be an object")
      require(root.keys == exactFields) { "external canary import fields are invalid" }
      require((root["schemaVersion"] as? JsonPrimitive)?.intOrNull == 1) {
        "external canary import version is invalid"
      }
      val envelope = (root["pairingEnvelope"] as? JsonPrimitive)?.contentOrNull
      require(envelope != null && envelope.startsWith(PAIRING_PREFIX) && envelope.length <= 16_384) {
        "external canary pairing envelope is invalid"
      }
      val expectedHost = (root["expectedHostInstanceId"] as? JsonPrimitive)?.contentOrNull
      val expectedInventory = (root["expectedInventoryId"] as? JsonPrimitive)?.contentOrNull
      require(expectedHost != null && opaqueIdentity.matches(expectedHost) && expectedHost.length <= 128) {
        "external canary host identity is invalid"
      }
      require(expectedInventory != null && opaqueIdentity.matches(expectedInventory)) {
        "external canary inventory identity is invalid"
      }
      val observerAttachAllowed =
        (root["observerAttachAllowed"] as? JsonPrimitive)?.booleanOrNull
          ?: throw IllegalArgumentException("external canary observer policy is invalid")
      return ExternalCanaryImport(
        pairingEnvelope = envelope,
        expectation =
          ExternalCanaryExpectation(
            hostInstanceId = expectedHost,
            inventoryId = expectedInventory,
            observerAttachAllowed = observerAttachAllowed,
          ),
      )
    }
  }
}

internal class ExternalCanaryImportException(
  val code: String,
) : IllegalStateException(code)

internal fun consumeExternalCanaryImport(context: Context): ExternalCanaryImport {
  val path = context.noBackupFilesDir.resolve(EXTERNAL_CANARY_IMPORT_FILENAME).toPath()
  var encoded: ByteArray? = null
  try {
    val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    if (!attributes.isRegularFile || attributes.isSymbolicLink || attributes.size() !in 1..MAX_IMPORT_BYTES.toLong()) {
      throw ExternalCanaryImportException("external_canary_import_invalid")
    }
    val bytes = Files.readAllBytes(path)
    encoded = bytes
    return try {
      ExternalCanaryImport.decode(bytes)
    } catch (_: Throwable) {
      throw ExternalCanaryImportException("external_canary_import_invalid")
    }
  } catch (error: ExternalCanaryImportException) {
    throw error
  } catch (_: Throwable) {
    throw ExternalCanaryImportException("external_canary_import_unavailable")
  } finally {
    encoded?.fill(0)
    runCatching { Files.deleteIfExists(path) }
  }
}

internal const val EXTERNAL_CANARY_IMPORT_FILENAME: String = "external-canary-import.json"
internal const val EXTERNAL_CANARY_ACTION: String = "com.harryaskham.pidroid.action.EXTERNAL_CANARY_IMPORT"
internal const val EXTERNAL_CANARY_INSECURE_ACTION: String =
  "com.harryaskham.pidroid.action.EXTERNAL_CANARY_IMPORT_INSECURE_HTTP"
private const val PAIRING_PREFIX: String = "pidroid://pair/v1/"
private const val MAX_IMPORT_BYTES: Int = 24 * 1_024
