package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.HostId
import java.nio.file.Files
import java.nio.file.Path

internal object SessionSurfaceTestFixtures {
  private val repositoryRoot = Path.of(requireNotNull(System.getProperty("piDaemon.repositoryRoot")))

  fun state(
    freshness: CacheFreshness = CacheFreshness.FRESH,
    observedAgeMillis: Long = 0,
  ): SessionSurfaceState =
    SessionFixtureDecoder.decode(
      host =
        SessionHostContext(
          hostId = HostId("workstation"),
          displayName = "Workstation",
          authority = HostAuthority(HostId("workstation"), 0, "host-fixture-01"),
          freshness = freshness,
          observedAgeMillis = observedAgeMillis,
        ),
      inventoryEnvelope = Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.inventory.response.json")),
      infoEnvelope = Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.info.response.json")),
      transcriptEnvelope = Files.readString(repositoryRoot.resolve("fixtures/session-api/dashboard.transcript.response.json")),
    )
}
