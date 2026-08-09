package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.NeutralHeaders
import com.harryaskham.pidroid.sdk.core.NeutralHttpResponse
import com.harryaskham.pidroid.sdk.core.SessionLifecycleCodec
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class SessionLifecycleProjectionTest {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val host =
    SessionHostContext(
      hostId = HostId("workstation"),
      displayName = "Workstation",
      authority = HostAuthority(HostId("workstation"), 0, "host-fixture-01"),
      freshness = CacheFreshness.FRESH,
      observedAgeMillis = 0,
    )

  @Test
  fun `decoded lifecycle resources project into existing bounded Rich surface`() {
    val inventory = SessionLifecycleCodec.decodeInventory(fixture("dashboard.inventory.response.json")).success()
    val info = SessionLifecycleCodec.decodeSessionInfo(fixture("dashboard.info.response.json")).success()
    val transcript = SessionLifecycleCodec.decodeTranscript(fixture("dashboard.transcript.response.json")).success()

    val projected =
      SessionLifecycleProjection.project(
        host = host,
        inventory = inventory,
        info = info,
        transcript = transcript,
        maxRetainedRecords = 2,
      )

    assertEquals("inventory-fixture-01", projected.session.inventoryId)
    assertEquals("fixture-model", projected.session.modelLabel)
    assertEquals(2, projected.records.size)
    assertEquals(
      "tool:tool-call-01",
      projected.records
        .first()
        .key.value,
    )
    assertEquals(TranscriptRole.TOOL, projected.records.first().role)
    assertFalse(projected.canMutate)
    assertTrue(projected.toString().contains("content=[REDACTED]"))
    assertFalse(projected.toString().contains("The fixture is ready"))
  }

  @Test
  fun `unavailable transcript remains truthful empty readonly state`() {
    val inventory = SessionLifecycleCodec.decodeInventory(fixture("dashboard.inventory.response.json")).success()
    val info = SessionLifecycleCodec.decodeSessionInfo(fixture("dashboard.info.response.json")).success()
    val transcript = SessionLifecycleCodec.decodeTranscript(fixture("dashboard.transcript.unavailable.response.json")).success()

    val projected = SessionLifecycleProjection.project(host, inventory, info, transcript)

    assertTrue(projected.records.isEmpty())
    assertFalse(projected.canMutate)
  }

  private fun fixture(name: String): NeutralHttpResponse =
    NeutralHttpResponse(
      status = 200,
      headers = NeutralHeaders.empty(),
      body = Files.readAllBytes(repositoryRoot.resolve("fixtures/session-api/$name")),
    )
}

private fun <T> com.harryaskham.pidroid.sdk.core.ApiResult<T>.success(): T =
  when (this) {
    is com.harryaskham.pidroid.sdk.core.ApiResult.Success -> value
    is com.harryaskham.pidroid.sdk.core.ApiResult.Failure -> throw AssertionError("expected success, got $this")
  }
