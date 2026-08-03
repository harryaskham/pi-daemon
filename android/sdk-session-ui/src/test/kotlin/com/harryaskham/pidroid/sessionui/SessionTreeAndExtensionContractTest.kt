package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.SessionRole
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class SessionTreeAndExtensionContractTest {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))
  private val identity =
    InteractiveSessionIdentity(
      authority = HostAuthority(HostId("workstation"), 0, "host-fixture-01"),
      sessionId = "session-fixture-01",
      generation = 3,
    )
  private val controller = InteractionContext(identity, SessionRole.CONTROLLER, CacheFreshness.FRESH)
  private val observer = InteractionContext(identity, SessionRole.OBSERVER, CacheFreshness.FRESH)

  @Test
  fun `bounded branch projection and navigation intent preserve exact identity and correlation`() {
    val tree = fixtureTree()
    val rows = SessionTreeProjection.rows(tree)
    assertEquals(listOf(0, 1, 2, 2), rows.map { it.depth })
    assertEquals(listOf("entry-root-01", "entry-user-01", "entry-assistant-01", "entry-alt-01"), rows.map { it.entry.id })
    assertEquals("entry-assistant-01", rows.single { it.entry.active }.entry.id)

    val intent =
      SessionTreeFixtureCodec.decodeIntent(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.tree-navigate.frame.json")),
        identity,
      )
    assertEquals("tree-navigation-01", intent.correlationId)
    assertEquals("entry-user-01", intent.entryId)
    assertTrue(intent.summarize)
    assertEquals("abandoned-review", intent.label)
    assertFalse(intent.toString().contains("Summarize the abandoned branch"))

    val readyDecision = SessionTreeAuthority.authorize(tree, intent, controller)
    assertInstanceOf(InteractionDecision.Ready::class.java, readyDecision)
    val readyIntent = (readyDecision as InteractionDecision.Ready<*>).intent as TreeNavigationIntent
    assertEquals(identity, readyIntent.identity)
    assertEquals("tree-navigation-01", readyIntent.correlationId)

    assertEquals("controller_required", blockedReason(SessionTreeAuthority.authorize(tree, intent, observer)))
    assertEquals(
      "freshness_required",
      blockedReason(SessionTreeAuthority.authorize(tree, intent, controller.copy(freshness = CacheFreshness.STALE))),
    )
    assertEquals(
      "identity_mismatch",
      blockedReason(
        SessionTreeAuthority.authorize(
          tree,
          intent,
          controller.copy(identity = identity.copy(generation = 4)),
        ),
      ),
    )
  }

  @Test
  fun `tree result correlation is exact and malformed graph fails closed`() {
    val intent =
      SessionTreeFixtureCodec.decodeIntent(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.tree-navigate.frame.json")),
        identity,
      )
    val result =
      SessionTreeFixtureCodec.decodeResult(
        Files.readString(repositoryRoot.resolve("fixtures/session-api/rpc.tree-navigate-result.frame.json")),
        intent,
      )
    assertEquals("entry-summary-01", result.summaryEntryId)
    assertFalse(result.cancelled)
    assertFalse(result.toString().contains("Revise this message"))

    val wrongCorrelation =
      Files
        .readString(repositoryRoot.resolve("fixtures/session-api/rpc.tree-navigate-result.frame.json"))
        .replace("tree-navigation-01", "tree-navigation-02")
    val mismatch =
      assertThrows(InteractiveSurfaceException::class.java) {
        SessionTreeFixtureCodec.decodeResult(wrongCorrelation, intent)
      }
    assertEquals("correlation_mismatch", mismatch.code)

    assertThrows(IllegalArgumentException::class.java) {
      SessionTreeSnapshot(
        identity = identity,
        entries =
          listOf(
            SessionTreeEntry("entry-a", "entry-b", SessionTreeEntryKind.USER, "A", false),
            SessionTreeEntry("entry-b", "entry-a", SessionTreeEntryKind.ASSISTANT, "B", true),
          ),
        activeEntryId = "entry-b",
      )
    }
  }

  @Test
  fun `declarative extension fixture stays inert and unsupported nodes use fallback`() {
    val stream = Files.readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.extension-view.json"))
    val view = ExtensionViewFixtureCodec.decodeStream(stream, CacheFreshness.FRESH, HostId("workstation"), 0)
    assertEquals(identity, view.identity)
    assertEquals("correlation-extension-view-01", view.correlationId)
    assertEquals("review-fixture-01", view.viewId)
    assertEquals(2, view.revision)
    assertTrue(view.nodes.any { it is ExtensionNode.Action })
    assertTrue(view.nodes.any { it is ExtensionNode.Form })
    assertTrue(view.nodes.size <= ExtensionViewState.MAX_NODES)
    assertFalse(view.toString().contains("export const safe"))

    val futureStream = stream.replaceFirst("\"type\": \"markdown\"", "\"type\": \"future-panel\"")
    val fallback = ExtensionViewFixtureCodec.decodeStream(futureStream, CacheFreshness.FRESH, HostId("workstation"), 0)
    val unsupported = fallback.nodes.filterIsInstance<ExtensionNode.Unsupported>().single()
    assertEquals("future-panel", unsupported.wireType)
    assertEquals("Review two changed files and choose whether to continue.", unsupported.fallbackText)
  }

  @Test
  fun `extension actions forms and UI responses require controller freshness and exact correlation`() {
    val view =
      ExtensionViewFixtureCodec.decodeStream(
        Files.readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.extension-view.json")),
        CacheFreshness.FRESH,
        HostId("workstation"),
        0,
      )
    val continueDecision = ExtensionInteractionAuthority.authorizeAction(view, "continue", emptyMap(), controller)
    assertInstanceOf(InteractionDecision.Ready::class.java, continueDecision)
    val continueIntent = (continueDecision as InteractionDecision.Ready<*>).intent as ExtensionActionIntent
    assertEquals("continue", continueIntent.actionId)
    assertEquals(view.identity, continueIntent.identity)

    assertEquals(
      "controller_required",
      blockedReason(ExtensionInteractionAuthority.authorizeAction(view, "continue", emptyMap(), observer)),
    )
    assertEquals(
      "freshness_required",
      blockedReason(
        ExtensionInteractionAuthority.authorizeAction(
          view.copy(freshness = CacheFreshness.OFFLINE_CACHED),
          "continue",
          emptyMap(),
          controller.copy(freshness = CacheFreshness.OFFLINE_CACHED),
        ),
      ),
    )

    val formIntent =
      ExtensionViewFixtureCodec.decodeFormResponse(
        Files.readString(repositoryRoot.resolve("fixtures/extension-view/response.valid.json")),
        view,
        correlationId = "correlation-extension-ui-01",
      )
    assertEquals("submit-review", formIntent.actionId)
    assertEquals(4, formIntent.values.size)
    assertFalse(formIntent.toString().contains("Looks safe"))
    assertInstanceOf(
      InteractionDecision.Ready::class.java,
      ExtensionInteractionAuthority.authorizeAction(view, formIntent.actionId, formIntent.values, controller),
    )
    assertEquals(
      "invalid_form_value",
      blockedReason(
        ExtensionInteractionAuthority.authorizeAction(
          view,
          formIntent.actionId,
          formIntent.values + ("decision" to ExtensionFormValue.Text("unknown")),
          controller,
        ),
      ),
    )

    val response =
      ExtensionViewFixtureCodec.correlateUiResponse(
        Files.readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.extension-ui-response.json")),
        formIntent,
      )
    assertTrue(response.confirmed)

    val wrong =
      Files
        .readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.extension-ui-response.json"))
        .replace("correlation-extension-ui-01", "correlation-extension-ui-02")
    val mismatch =
      assertThrows(InteractiveSurfaceException::class.java) {
        ExtensionViewFixtureCodec.correlateUiResponse(wrong, formIntent)
      }
    assertEquals("correlation_mismatch", mismatch.code)
  }

  private fun fixtureTree(): SessionTreeSnapshot =
    SessionTreeSnapshot(
      identity = identity,
      entries =
        listOf(
          SessionTreeEntry("entry-root-01", null, SessionTreeEntryKind.SYSTEM, "Session start", false),
          SessionTreeEntry("entry-user-01", "entry-root-01", SessionTreeEntryKind.USER, "User request", false),
          SessionTreeEntry("entry-assistant-01", "entry-user-01", SessionTreeEntryKind.ASSISTANT, "Active answer", true),
          SessionTreeEntry("entry-alt-01", "entry-user-01", SessionTreeEntryKind.ASSISTANT, "Abandoned review", false),
        ),
      activeEntryId = "entry-assistant-01",
    )

  private fun blockedReason(decision: InteractionDecision<*>): String =
    assertInstanceOf(InteractionDecision.Blocked::class.java, decision).reason
}
