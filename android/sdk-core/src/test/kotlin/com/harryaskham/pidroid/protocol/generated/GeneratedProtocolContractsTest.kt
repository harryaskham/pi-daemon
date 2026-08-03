package com.harryaskham.pidroid.protocol.generated

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

class GeneratedProtocolContractsTest {
  private val repositoryRoot: Path =
    Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val json = Json

  @Test
  fun `all generated inputs match repository bytes`() {
    assertTrue(GeneratedProtocolContracts.inputs.count { it.kind == ProtocolInputKind.CONTRACT } == 10)
    assertTrue(GeneratedProtocolContracts.inputs.count { it.kind == ProtocolInputKind.FIXTURE } > 50)

    for (input in GeneratedProtocolContracts.inputs) {
      val bytes = Files.readAllBytes(repositoryRoot.resolve(input.path))
      assertEquals(input.sha256, bytes.sha256(), input.path)
    }
  }

  @Test
  fun `allOf fields and additive fixture fields round trip without loss`() {
    val definition =
      GeneratedProtocolContracts.definition("protocol-v2.schema.json", "openCommand")
    assertEquals(
      setOf(
        "generation",
        "operation",
        "payload",
        "protocolVersion",
        "requestId",
        "sessionId",
      ),
      definition.knownFields,
    )

    val fixture =
      json
        .parseToJsonElement(
          Files.readString(
            repositoryRoot.resolve("fixtures/open-v2-configured-no-tools.command.json"),
          ),
        ).jsonObject
    val additiveValue =
      JsonObject(
        mapOf(
          "nested" to
            JsonArray(
              listOf(
                JsonPrimitive("future"),
                JsonObject(mapOf("revision" to JsonPrimitive(2))),
              ),
            ),
        ),
      )
    val futureFixture = JsonObject(fixture + ("futureAndroidField" to additiveValue))

    val partitioned = GeneratedProtocolContracts.partitionKnownFields(definition, futureFixture)

    assertEquals(JsonObject(mapOf("futureAndroidField" to additiveValue)), partitioned.additionalFields)
    assertEquals(futureFixture, partitioned.toJsonObject())
  }

  @Test
  fun `Pi RPC command types come from the canonical fixture`() {
    val fixture =
      json
        .parseToJsonElement(
          Files.readString(repositoryRoot.resolve("fixtures/pi-rpc-command-types.json")),
        ).jsonObject
    val expected = fixture.getValue("commandTypes").jsonArray.map { it.jsonPrimitive.content }

    assertEquals(expected, PiRpcCommandType.entries.map(PiRpcCommandType::wireValue))
    for (wireValue in expected) {
      assertNotNull(PiRpcCommandType.fromWireValue(wireValue))
    }
    assertEquals(null, PiRpcCommandType.fromWireValue("future_additive_command"))
  }

  @Test
  fun `unsupported schema flattening remains explicit`() {
    val diagnostics = GeneratedProtocolContracts.definitions.flatMap(SchemaDefinition::diagnostics)
    assertTrue(diagnostics.isNotEmpty())
    assertTrue(diagnostics.any { it.contains("unevaluatedProperties") })
    assertTrue(diagnostics.all { it.contains("not flattened") })
  }
}

private fun ByteArray.sha256(): String =
  MessageDigest
    .getInstance("SHA-256")
    .digest(this)
    .joinToString(separator = "") { byte -> "%02x".format(byte) }
