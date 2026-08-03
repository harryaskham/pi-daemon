package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class SessionSurfaceReducerTest {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val json = Json
  private val host =
    SessionHostContext(
      hostId = HostId("workstation"),
      displayName = "Workstation",
      authority = HostAuthority(HostId("workstation"), 0, "host-fixture-01"),
      freshness = CacheFreshness.FRESH,
      observedAgeMillis = 0,
    )

  @Test
  fun `fixture decoder projects readonly inventory info and transcript with stable keys`() {
    val state = fixtureState()

    assertEquals("Contract fixture", state.session.title)
    assertEquals("Workstation", state.host.displayName)
    assertEquals(3, state.records.size)
    assertEquals(
      listOf("entry:entry-user-01", "tool:tool-call-01", "entry:entry-assistant-01"),
      state.records.map { it.key.value },
    )
    assertEquals(listOf("user", "tool", "assistant"), state.records.map { it.role.wireValue })
    assertFalse(state.toString().contains("/srv/state"))
    assertFalse(state.toString().contains("Show the contract fixture"))
  }

  @Test
  fun `duplicate stable keys replace in place without reordering`() {
    val fixture = transcriptFixture()
    val records = fixture.getValue("data").jsonObject.getValue("records") as JsonArray
    val replacement =
      JsonObject(
        records.first().jsonObject +
          (
            "content" to
              JsonArray(
                listOf(
                  JsonObject(
                    mapOf(
                      "type" to JsonPrimitive("text"),
                      "text" to JsonPrimitive("Replacement content"),
                    ),
                  ),
                ),
              )
          ),
      )
    val changedData = JsonObject(fixture.getValue("data").jsonObject + ("records" to JsonArray(records + replacement)))
    val changed = JsonObject(fixture + ("data" to changedData))

    val state = fixtureState(transcript = changed.toString())

    assertEquals(3, state.records.size)
    assertEquals(
      "entry:entry-user-01",
      state.records
        .first()
        .key.value,
    )
    assertEquals(
      "Replacement content",
      state.records
        .first()
        .blocks
        .single()
        .text,
    )
  }

  @Test
  fun `retention and content bounds keep the newest stable records`() {
    val fixture = transcriptFixture()
    val template =
      fixture
        .getValue("data")
        .jsonObject
        .getValue("records")
        .jsonArray
        .first()
        .jsonObject
    val records =
      (0 until 600).map { index ->
        JsonObject(
          template +
            mapOf(
              "recordId" to JsonPrimitive("entry:bounded-$index"),
              "key" to
                JsonObject(
                  mapOf(
                    "entryId" to JsonPrimitive("bounded-$index"),
                    "messageId" to JsonPrimitive("message-$index"),
                  ),
                ),
              "content" to
                JsonArray(
                  listOf(
                    JsonObject(
                      mapOf(
                        "type" to JsonPrimitive("text"),
                        "text" to JsonPrimitive("x".repeat(2_000)),
                      ),
                    ),
                  ),
                ),
            ),
        )
      }
    val changedData = JsonObject(fixture.getValue("data").jsonObject + ("records" to JsonArray(records)))

    val state =
      fixtureState(
        transcript = JsonObject(fixture + ("data" to changedData)).toString(),
        maxRetainedRecords = 120,
        maxContentChars = 256,
      )

    assertEquals(120, state.records.size)
    assertEquals(
      "entry:bounded-480",
      state.records
        .first()
        .key.value,
    )
    assertEquals(
      256,
      state.records
        .first()
        .blocks
        .single()
        .text.length,
    )
    assertTrue(
      state.records
        .first()
        .blocks
        .single()
        .truncated,
    )
  }

  @Test
  fun `freshness transitions remain explicit and mutation capability stays absent`() {
    val state = fixtureState()
    val reconnecting = SessionSurfaceReducer.withFreshness(state, CacheFreshness.RECONNECTING, 2_000)
    val offline = SessionSurfaceReducer.withFreshness(reconnecting, CacheFreshness.OFFLINE_CACHED, 65_000)

    assertEquals("Reconnecting · 2s", reconnecting.freshnessLabel)
    assertEquals("Offline cached · 1m", offline.freshnessLabel)
    assertFalse(offline.canMutate)
    assertEquals(SessionSurfaceMode.READONLY, offline.mode)
  }

  @Test
  fun `model surface exposes no bearer controller prompt or canonical path fields`() {
    val forbidden = setOf("bearer", "token", "credential", "prompt", "controller", "canonicalPath", "cwd")
    val propertyNames =
      SessionSurfaceState::class.java.declaredFields
        .map { it.name }
        .toSet() +
        SessionHostContext::class.java.declaredFields
          .map { it.name }
          .toSet() +
        SessionInfoModel::class.java.declaredFields
          .map { it.name }
          .toSet()

    assertTrue(propertyNames.none { it in forbidden })
  }

  private fun fixtureState(
    transcript: String = Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.transcript.response.json")),
    maxRetainedRecords: Int = 500,
    maxContentChars: Int = 16_384,
  ): SessionSurfaceState =
    SessionFixtureDecoder.decode(
      host = host,
      inventoryEnvelope = Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.inventory.response.json")),
      infoEnvelope = Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.info.response.json")),
      transcriptEnvelope = transcript,
      maxRetainedRecords = maxRetainedRecords,
      maxContentChars = maxContentChars,
    )

  private fun transcriptFixture(): JsonObject =
    json
      .parseToJsonElement(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.transcript.response.json")),
      ).jsonObject
}
