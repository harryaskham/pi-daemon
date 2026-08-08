package com.harryaskham.pidroid

import com.harryaskham.pidroid.sdk.core.PairingPayloadCodec
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Path

class ExternalCanaryImportTest {
  @Test
  fun `fixture decodes exact fenced identity without rendering its bearer`() {
    val encoded = repositoryRoot.resolve("fixtures/android/external-canary-import.json").toFile().readBytes()
    val imported = ExternalCanaryImport.decode(encoded)

    assertEquals("host-fixture-01", imported.expectation.hostInstanceId)
    assertEquals("inventory-fixture-01", imported.expectation.inventoryId)
    assertTrue(imported.expectation.observerAttachAllowed)
    PairingPayloadCodec.decode(imported.pairingEnvelope).use { payload ->
      assertEquals("http://127.0.0.1:43123", payload.apiUri.toString())
      payload.useBearer { bearer ->
        assertEquals("0123456789abcdef".repeat(4), bearer.concatToString())
      }
    }
    assertEquals(
      "ExternalCanaryImport(pairingEnvelope=[REDACTED], expectation=${imported.expectation})",
      imported.toString(),
    )
    assertFalse(imported.toString().contains("pidroid://"))
    assertFalse(imported.toString().contains("0123456789abcdef"))
  }

  @Test
  fun `unsupported fields and oversized payloads fail closed`() {
    val fixture = repositoryRoot.resolve("fixtures/android/external-canary-import.json").toFile().readText()
    assertThrows(IllegalArgumentException::class.java) {
      ExternalCanaryImport.decode(fixture.replaceFirst("{", "{\"unexpected\":true,").encodeToByteArray())
    }
    assertThrows(IllegalArgumentException::class.java) {
      ExternalCanaryImport.decode(ByteArray(24 * 1_024 + 1) { 'x'.code.toByte() })
    }
  }

  private companion object {
    val repositoryRoot: Path = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  }
}
