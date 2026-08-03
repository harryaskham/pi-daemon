package com.harryaskham.pidroid.sdk.core

public data class HostAuthority(
  public val hostId: HostId,
  public val bearerGeneration: Int,
  public val hostInstanceId: String,
) {
  init {
    require(bearerGeneration >= 0) { "bearer generation must be non-negative" }
    require(hostInstanceId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))) {
      "host instance ID must be a bounded identifier"
    }
  }
}

public data class CanonicalResourceIdentity(
  public val authority: HostAuthority,
  public val resourceId: String,
  public val generation: Int,
  public val revision: String,
) {
  init {
    require(resourceId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"))) {
      "resource ID must be a bounded identifier"
    }
    require(generation >= 0) { "resource generation must be non-negative" }
    require(revision.isNotEmpty() && revision.length <= 256 && '\r' !in revision && '\n' !in revision) {
      "resource revision is invalid or too long"
    }
  }
}

public enum class CacheFreshness {
  FRESH,
  RECONNECTING,
  STALE,
  RESYNCING,
  OFFLINE_CACHED,
  REMOVED,
}

public data class CacheQuotas(
  public val maxEntriesPerHost: Int,
  public val maxBytesPerHost: Long,
  public val maxEntriesGlobal: Int,
  public val maxBytesGlobal: Long,
  public val maxAgeMillis: Long,
) {
  init {
    require(maxEntriesPerHost > 0 && maxEntriesGlobal >= maxEntriesPerHost) {
      "cache entry quotas are invalid"
    }
    require(maxBytesPerHost > 0 && maxBytesGlobal >= maxBytesPerHost) {
      "cache byte quotas are invalid"
    }
    require(maxAgeMillis > 0) { "cache age quota must be positive" }
  }
}

public interface ObservationClock {
  public val wallTimeMillis: Long
  public val elapsedRealtimeMillis: Long
  public val bootId: String
}

public class CachedResource<T> internal constructor(
  public val identity: CanonicalResourceIdentity,
  public val value: T,
  public val freshness: CacheFreshness,
  public val observedWallTimeMillis: Long,
) {
  override fun toString(): String =
    "CachedResource(identity=$identity, freshness=$freshness, observedWallTimeMillis=$observedWallTimeMillis, value=[REDACTED])"
}

/**
 * In-memory reference semantics for a future encrypted Room/no-backup cache implementation.
 * Authority replacement purges incompatible bearer/host-instance partitions; generation changes
 * replace one resource only. Boot changes and elapsed age make values stale. Partial/failed scans
 * never tombstone; only a complete authoritative scan may mark absent resources [CacheFreshness.REMOVED].
 */
public class CanonicalMultiHostCache<T>(
  public val quotas: CacheQuotas,
  private val clock: ObservationClock,
) {
  private val authorities = linkedMapOf<HostId, HostAuthority>()
  private val hostFreshness = linkedMapOf<HostAuthority, CacheFreshness>()
  private val entries = linkedMapOf<CanonicalResourceIdentity, Entry<T>>()

  @Synchronized
  public fun activateAuthority(authority: HostAuthority) {
    val previous = authorities[authority.hostId]
    if (previous != authority) {
      entries.keys.removeAll { it.authority.hostId == authority.hostId }
      previous?.let(hostFreshness::remove)
      authorities[authority.hostId] = authority
      hostFreshness[authority] = CacheFreshness.RESYNCING
    }
  }

  @Synchronized
  public fun put(
    identity: CanonicalResourceIdentity,
    value: T,
    sizeBytes: Long,
  ) {
    require(sizeBytes in 1..quotas.maxBytesPerHost) { "cache record size exceeds the per-host bound" }
    require(authorities[identity.authority.hostId] == identity.authority) {
      "cache write authority is not active"
    }
    entries.keys.removeAll { existing ->
      existing.authority == identity.authority &&
        existing.resourceId == identity.resourceId &&
        existing != identity
    }
    entries[identity] =
      Entry(
        value = value,
        sizeBytes = sizeBytes,
        observedWallTimeMillis = clock.wallTimeMillis,
        observedElapsedRealtimeMillis = clock.elapsedRealtimeMillis,
        bootId = clock.bootId,
        removed = false,
      )
    hostFreshness[identity.authority] = CacheFreshness.FRESH
    enforceQuotas(identity.authority.hostId)
  }

  @Synchronized
  public fun view(identity: CanonicalResourceIdentity): CachedResource<T>? {
    val entry = entries[identity] ?: return null
    val explicit = hostFreshness[identity.authority] ?: CacheFreshness.STALE
    val freshness =
      when {
        entry.removed -> CacheFreshness.REMOVED

        explicit in
          setOf(
            CacheFreshness.RECONNECTING,
            CacheFreshness.RESYNCING,
            CacheFreshness.OFFLINE_CACHED,
          )
        -> explicit

        entry.bootId != clock.bootId -> CacheFreshness.STALE

        clock.elapsedRealtimeMillis < entry.observedElapsedRealtimeMillis -> CacheFreshness.STALE

        clock.elapsedRealtimeMillis - entry.observedElapsedRealtimeMillis > quotas.maxAgeMillis -> CacheFreshness.STALE

        else -> explicit
      }
    return CachedResource(identity, entry.value, freshness, entry.observedWallTimeMillis)
  }

  @Synchronized
  public fun hostFreshness(authority: HostAuthority): CacheFreshness = hostFreshness[authority] ?: CacheFreshness.STALE

  @Synchronized
  public fun markConnectivity(
    authority: HostAuthority,
    freshness: CacheFreshness,
  ) {
    require(authorities[authority.hostId] == authority) { "host authority is not active" }
    require(freshness != CacheFreshness.REMOVED) { "removed is a resource state, not host connectivity" }
    hostFreshness[authority] = freshness
  }

  @Synchronized
  public fun reconcileScan(
    authority: HostAuthority,
    observed: Set<CanonicalResourceIdentity>,
    complete: Boolean,
  ) {
    require(authorities[authority.hostId] == authority) { "scan authority is not active" }
    require(observed.all { it.authority == authority }) { "scan contains a foreign cache identity" }
    if (!complete) return
    for ((identity, entry) in entries) {
      if (identity.authority == authority) {
        entry.removed = identity !in observed
      }
    }
    hostFreshness[authority] = CacheFreshness.FRESH
  }

  @Synchronized
  public fun evictExpired() {
    val now = clock.elapsedRealtimeMillis
    val boot = clock.bootId
    entries.entries.removeIf { (_, entry) ->
      entry.bootId == boot && now >= entry.observedElapsedRealtimeMillis &&
        now - entry.observedElapsedRealtimeMillis > quotas.maxAgeMillis
    }
  }

  @Synchronized
  public fun entryCount(authority: HostAuthority): Int = entries.keys.count { it.authority == authority }

  @Synchronized
  public fun totalEntryCount(): Int = entries.size

  @Synchronized
  public fun totalBytes(): Long = entries.values.sumOf(Entry<T>::sizeBytes)

  private fun enforceQuotas(changedHost: HostId) {
    while (
      entries.keys.count { it.authority.hostId == changedHost } > quotas.maxEntriesPerHost ||
      entries.filterKeys { it.authority.hostId == changedHost }.values.sumOf(Entry<T>::sizeBytes) >
      quotas.maxBytesPerHost
    ) {
      evictOldest { it.authority.hostId == changedHost }
    }
    while (entries.size > quotas.maxEntriesGlobal || totalBytes() > quotas.maxBytesGlobal) {
      evictOldest { true }
    }
  }

  private fun evictOldest(matches: (CanonicalResourceIdentity) -> Boolean) {
    val oldest =
      entries.entries
        .filter { matches(it.key) }
        .minWithOrNull(
          compareBy<Map.Entry<CanonicalResourceIdentity, Entry<T>>> { it.value.observedElapsedRealtimeMillis }
            .thenBy { it.key.authority.hostId.value }
            .thenBy { it.key.resourceId }
            .thenBy { it.key.generation }
            .thenBy { it.key.revision },
        )?.key ?: return
    entries.remove(oldest)
  }

  private class Entry<T>(
    val value: T,
    val sizeBytes: Long,
    val observedWallTimeMillis: Long,
    val observedElapsedRealtimeMillis: Long,
    val bootId: String,
    var removed: Boolean,
  )
}
