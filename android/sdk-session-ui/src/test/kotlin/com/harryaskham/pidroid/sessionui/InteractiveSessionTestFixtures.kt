package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.SessionRole
import java.nio.file.Files
import java.nio.file.Path

internal object InteractiveSessionTestFixtures {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))

  val identity: InteractiveSessionIdentity =
    InteractiveSessionIdentity(
      authority = HostAuthority(HostId("workstation"), 0, "host-fixture-01"),
      sessionId = "session-fixture-01",
      generation = 3,
    )

  fun context(
    role: SessionRole = SessionRole.CONTROLLER,
    freshness: CacheFreshness = CacheFreshness.FRESH,
  ): InteractionContext = InteractionContext(identity, role, freshness)

  fun tree(): SessionTreeSnapshot =
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

  fun extensionView(
    freshness: CacheFreshness = CacheFreshness.FRESH,
    unsupported: Boolean = false,
  ): ExtensionViewState {
    var text = Files.readString(repositoryRoot.resolve("fixtures/dashboard-api/stream.extension-view.json"))
    if (unsupported) text = text.replaceFirst("\"type\": \"markdown\"", "\"type\": \"future-panel\"")
    return ExtensionViewFixtureCodec.decodeStream(text, freshness, HostId("workstation"), 0)
  }

  fun completeFormValues(): Map<String, ExtensionFormValue> =
    mapOf(
      "summary" to ExtensionFormValue.Text("Looks safe"),
      "decision" to ExtensionFormValue.Text("approve"),
      "confirmed" to ExtensionFormValue.Toggle(true),
      "notes" to ExtensionFormValue.Text("Bounded fixture"),
    )
}
