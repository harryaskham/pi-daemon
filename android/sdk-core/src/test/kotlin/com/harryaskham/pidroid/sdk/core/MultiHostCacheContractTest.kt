package com.harryaskham.pidroid.sdk.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class MultiHostCacheContractTest {
  private val clock = FakeObservationClock()
  private val quotas =
    CacheQuotas(
      maxEntriesPerHost = 2,
      maxBytesPerHost = 100,
      maxEntriesGlobal = 3,
      maxBytesGlobal = 160,
      maxAgeMillis = 1_000,
    )

  @Test
  fun `host bearer instance and generation form canonical cache identity`() {
    val cache = CanonicalMultiHostCache<String>(quotas, clock)
    val firstAuthority = authority("host-a", bearerGeneration = 0, hostInstanceId = "instance-1")
    val first = resource(firstAuthority, "session-a", generation = 1, revision = "r1")
    val sameSessionOtherHost =
      resource(authority("host-b", 0, "instance-1"), "session-a", generation = 1, revision = "r1")
    assertNotEquals(first, sameSessionOtherHost)

    cache.activateAuthority(firstAuthority)
    cache.put(first, "first", sizeBytes = 10)
    assertEquals(CacheFreshness.FRESH, cache.view(first)?.freshness)

    val rotated = authority("host-a", bearerGeneration = 1, hostInstanceId = "instance-1")
    cache.activateAuthority(rotated)
    assertNull(cache.view(first))
    assertEquals(CacheFreshness.RESYNCING, cache.hostFreshness(rotated))

    val replacement = resource(rotated, "session-a", generation = 2, revision = "r2")
    cache.put(replacement, "replacement", sizeBytes = 12)
    assertEquals("replacement", cache.view(replacement)?.value)
    assertNull(cache.view(resource(rotated, "session-a", generation = 1, revision = "r1")))

    val restarted = authority("host-a", bearerGeneration = 1, hostInstanceId = "instance-2")
    cache.activateAuthority(restarted)
    assertNull(cache.view(replacement))
    assertEquals(CacheFreshness.RESYNCING, cache.hostFreshness(restarted))
  }

  @Test
  fun `boot identity and connectivity make cached state honestly stale or offline`() {
    val cache = CanonicalMultiHostCache<String>(quotas, clock)
    val authority = authority("host-a", 0, "instance-1")
    val identity = resource(authority, "session-a", 1, "r1")
    cache.activateAuthority(authority)
    cache.put(identity, "cached", sizeBytes = 10)

    clock.bootId = "boot-2"
    assertEquals(CacheFreshness.STALE, cache.view(identity)?.freshness)

    cache.markConnectivity(authority, CacheFreshness.OFFLINE_CACHED)
    assertEquals(CacheFreshness.OFFLINE_CACHED, cache.view(identity)?.freshness)
    cache.markConnectivity(authority, CacheFreshness.RECONNECTING)
    assertEquals(CacheFreshness.RECONNECTING, cache.view(identity)?.freshness)
  }

  @Test
  fun `only complete authoritative scans tombstone absent resources`() {
    val cache = CanonicalMultiHostCache<String>(quotas, clock)
    val authority = authority("host-a", 0, "instance-1")
    val present = resource(authority, "session-present", 1, "r1")
    val missing = resource(authority, "session-missing", 1, "r1")
    cache.activateAuthority(authority)
    cache.put(present, "present", sizeBytes = 10)
    cache.put(missing, "missing", sizeBytes = 10)

    cache.reconcileScan(authority, observed = setOf(present), complete = false)
    assertNotEquals(CacheFreshness.REMOVED, cache.view(missing)?.freshness)

    cache.reconcileScan(authority, observed = setOf(present), complete = true)
    assertEquals(CacheFreshness.REMOVED, cache.view(missing)?.freshness)
    assertEquals(CacheFreshness.FRESH, cache.view(present)?.freshness)
  }

  @Test
  fun `per-host global and age quotas evict oldest observations deterministically`() {
    val cache = CanonicalMultiHostCache<String>(quotas, clock)
    val hostA = authority("host-a", 0, "instance-1")
    val hostB = authority("host-b", 0, "instance-1")
    cache.activateAuthority(hostA)
    cache.activateAuthority(hostB)

    val a1 = resource(hostA, "a1", 1, "r1")
    val a2 = resource(hostA, "a2", 1, "r1")
    val a3 = resource(hostA, "a3", 1, "r1")
    cache.put(a1, "a1", sizeBytes = 30)
    clock.advance(1)
    cache.put(a2, "a2", sizeBytes = 30)
    clock.advance(1)
    cache.put(a3, "a3", sizeBytes = 30)
    assertNull(cache.view(a1))
    assertEquals(2, cache.entryCount(hostA))

    val b1 = resource(hostB, "b1", 1, "r1")
    val b2 = resource(hostB, "b2", 1, "r1")
    clock.advance(1)
    cache.put(b1, "b1", sizeBytes = 30)
    clock.advance(1)
    cache.put(b2, "b2", sizeBytes = 30)
    assertTrue(cache.totalEntryCount() <= quotas.maxEntriesGlobal)
    assertTrue(cache.totalBytes() <= quotas.maxBytesGlobal)

    clock.advance(quotas.maxAgeMillis + 1)
    cache.evictExpired()
    assertEquals(0, cache.totalEntryCount())
  }

  @Test
  fun `fair paging interleaves healthy hosts and preserves failed host cursor state`() {
    val pages =
      listOf(
        HostInventoryPage(
          hostId = HostId("host-a"),
          items = listOf("a1", "a2", "a3"),
          nextCursor = "cursor-a",
          snapshotRevision = "revision-a",
          exhausted = false,
        ),
        HostInventoryPage(
          hostId = HostId("host-b"),
          items = listOf("b1", "b2"),
          nextCursor = null,
          snapshotRevision = "revision-b",
          exhausted = true,
        ),
        HostInventoryPage.failed<String>(
          hostId = HostId("host-c"),
          priorCursor = "cursor-c",
          safeErrorCode = "host_unavailable",
        ),
      )

    val merged = FairMultiHostPager.merge(queryDigest = "query-v1", pages = pages, limit = 5)

    assertEquals(listOf("a1", "b1", "a2", "b2", "a3"), merged.items.map { it.value })
    assertEquals(listOf("host-a", "host-b", "host-a", "host-b", "host-a"), merged.items.map { it.hostId.value })
    assertTrue(merged.partial)
    assertEquals(
      "cursor-c",
      merged.cursor.hosts
        .getValue(HostId("host-c"))
        .nextCursor,
    )
    assertEquals(
      "host_unavailable",
      merged.cursor.hosts
        .getValue(HostId("host-c"))
        .safeErrorCode,
    )
    assertFalse(
      merged.cursor.hosts
        .getValue(HostId("host-a"))
        .exhausted,
    )
    assertEquals("query-v1", merged.cursor.queryDigest)
  }

  private fun authority(
    hostId: String,
    bearerGeneration: Int,
    hostInstanceId: String,
  ): HostAuthority = HostAuthority(HostId(hostId), bearerGeneration, hostInstanceId)

  private fun resource(
    authority: HostAuthority,
    resourceId: String,
    generation: Int,
    revision: String,
  ): CanonicalResourceIdentity =
    CanonicalResourceIdentity(
      authority = authority,
      resourceId = resourceId,
      generation = generation,
      revision = revision,
    )

  private class FakeObservationClock : ObservationClock {
    override var wallTimeMillis: Long = 1_000
    override var elapsedRealtimeMillis: Long = 1_000
    override var bootId: String = "boot-1"

    fun advance(millis: Long) {
      wallTimeMillis += millis
      elapsedRealtimeMillis += millis
    }
  }
}
