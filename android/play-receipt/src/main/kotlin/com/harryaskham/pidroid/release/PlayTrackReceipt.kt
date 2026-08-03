package com.harryaskham.pidroid.release

import com.github.triplet.gradle.androidpublisher.EditManager
import com.github.triplet.gradle.androidpublisher.EditResponse
import com.github.triplet.gradle.androidpublisher.PlayPublisher
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Instant

fun main() {
  val credentials = requiredFile("PI_DROID_PLAY_SERVICE_ACCOUNT_FILE")
  val packageName = requiredValue("PI_DROID_PLAY_PACKAGE")
  val expectedTrack = requiredValue("PI_DROID_PLAY_TRACK")
  val expectedVersionCode =
    requiredValue("PI_DROID_PLAY_VERSION_CODE").toLongOrNull()
      ?: error("PI_DROID_PLAY_VERSION_CODE must be an integer")
  val output = Path.of(requiredValue("PI_DROID_PLAY_RECEIPT_FILE"))

  require(expectedTrack == "internal") { "only the internal Play track is allowed" }
  require(packageName == "com.harryaskham.pidroid") { "unexpected Play package" }
  require(expectedVersionCode > 0) { "Play version code must be positive" }

  val publisher =
    Files.newInputStream(credentials).use { input ->
      PlayPublisher(input, packageName)
    }
  val editId =
    when (val edit = publisher.insertEdit()) {
      is EditResponse.Success -> edit.id
      is EditResponse.Failure -> edit.rethrow("could not open a Play verification edit")
    }
  val manager = EditManager(publisher, editId)
  val observedVersionCode = manager.findMaxAppVersionCode()
  val observedTrack = manager.findLeastStableTrackName()
  publisher.validateEdit(editId)

  require(observedVersionCode == expectedVersionCode) {
    "Play highest version code $observedVersionCode does not equal expected $expectedVersionCode"
  }
  require(observedTrack == expectedTrack) {
    "Play highest-version track '$observedTrack' does not equal internal"
  }

  val receipt =
    """
    {
      "schemaVersion": 1,
      "status": "verified",
      "packageName": ${jsonString(packageName)},
      "track": ${jsonString(observedTrack)},
      "versionCode": $observedVersionCode,
      "verificationEditId": ${jsonString(editId)},
      "verifiedAt": ${jsonString(Instant.now().toString())}
    }
    """.trimIndent() + "\n"
  val outputParent = requireNotNull(output.parent) { "PI_DROID_PLAY_RECEIPT_FILE must include a parent directory" }
  Files.createDirectories(outputParent)
  val temporary = Files.createTempFile(outputParent, ".${output.fileName}.", ".tmp")
  try {
    Files.writeString(temporary, receipt)
    try {
      Files.move(
        temporary,
        output,
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING,
      )
    } catch (_: UnsupportedOperationException) {
      Files.move(temporary, output, StandardCopyOption.REPLACE_EXISTING)
    }
  } finally {
    Files.deleteIfExists(temporary)
  }

  println("Play internal receipt verified: package=$packageName versionCode=$observedVersionCode editId=$editId")
}

private fun requiredValue(name: String): String =
  System.getenv(name)?.takeIf(String::isNotBlank)
    ?: error("$name is required")

private fun requiredFile(name: String): Path {
  val path = Path.of(requiredValue(name))
  require(Files.isRegularFile(path) && Files.isReadable(path)) { "$name must name a readable file" }
  return path
}

private fun jsonString(value: String?): String =
  value?.let { text ->
    buildString {
      append('"')
      text.forEach { character ->
        when (character) {
          '"' -> append("\\\"")
          '\\' -> append("\\\\")
          '\n' -> append("\\n")
          '\r' -> append("\\r")
          '\t' -> append("\\t")
          else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
        }
      }
      append('"')
    }
  } ?: "null"
