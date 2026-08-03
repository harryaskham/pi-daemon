package com.harryaskham.pidroid.sdk.core

public class HostInventoryPage<T>(
  public val hostId: HostId,
  public val items: List<T>,
  public val nextCursor: String?,
  public val snapshotRevision: String?,
  public val exhausted: Boolean,
  public val safeErrorCode: String? = null,
) {
  init {
    require(items.size <= 10_000) { "host inventory page is too large" }
    require(
      nextCursor == null ||
        (nextCursor.length in 1..2_048 && '\r' !in nextCursor && '\n' !in nextCursor),
    ) { "host cursor is invalid or too long" }
    require(
      snapshotRevision == null ||
        (snapshotRevision.length in 1..256 && '\r' !in snapshotRevision && '\n' !in snapshotRevision),
    ) {
      "host snapshot revision is invalid or too long"
    }
    require(safeErrorCode == null || safeErrorCode.matches(Regex("^[a-z][a-z0-9_]{0,127}$"))) {
      "host safe error code is invalid"
    }
    require(safeErrorCode == null || items.isEmpty()) { "failed host page must not contain items" }
  }

  override fun toString(): String =
    "HostInventoryPage(hostId=${hostId.value}, items=${items.size}, nextCursor=${nextCursor != null}, snapshotRevision=${snapshotRevision != null}, exhausted=$exhausted, safeErrorCode=$safeErrorCode, content=[REDACTED])"

  public companion object {
    public fun <T> failed(
      hostId: HostId,
      priorCursor: String?,
      safeErrorCode: String,
    ): HostInventoryPage<T> =
      HostInventoryPage(
        hostId = hostId,
        items = emptyList(),
        nextCursor = priorCursor,
        snapshotRevision = null,
        exhausted = false,
        safeErrorCode = safeErrorCode,
      )
  }
}

public class HostInventoryItem<T>(
  public val hostId: HostId,
  public val value: T,
) {
  override fun toString(): String = "HostInventoryItem(hostId=${hostId.value}, value=[REDACTED])"
}

public class HostCursorState(
  public val nextCursor: String?,
  public val snapshotRevision: String?,
  public val exhausted: Boolean,
  public val safeErrorCode: String?,
  public val consumedFromPage: Int,
  public val pageItemCount: Int,
) {
  override fun toString(): String =
    "HostCursorState(nextCursor=${nextCursor != null}, snapshotRevision=${snapshotRevision != null}, exhausted=$exhausted, safeErrorCode=$safeErrorCode, consumedFromPage=$consumedFromPage, pageItemCount=$pageItemCount)"
}

public class MultiHostCursor(
  public val queryDigest: String,
  public val hosts: Map<HostId, HostCursorState>,
) {
  override fun toString(): String = "MultiHostCursor(queryDigest=[OPAQUE], hostIds=${hosts.keys.map(HostId::value)})"
}

public class FairInventoryPage<T>(
  public val items: List<HostInventoryItem<T>>,
  public val cursor: MultiHostCursor,
  public val partial: Boolean,
) {
  override fun toString(): String =
    "FairInventoryPage(items=${items.size}, hosts=${cursor.hosts.size}, partial=$partial, content=[REDACTED])"
}

/**
 * Pure bounded fair merge over independently fetched host pages. One failed/slow host contributes a
 * preserved cursor and safe error while healthy hosts continue. Consumers must retain unconsumed
 * page items until [HostCursorState.consumedFromPage] reaches `pageItemCount`; only then may the
 * host's `nextCursor` be fetched. Host order is deterministic and round-robin, so a large page cannot
 * starve another host.
 */
public object FairMultiHostPager {
  public fun <T> merge(
    queryDigest: String,
    pages: List<HostInventoryPage<T>>,
    limit: Int,
  ): FairInventoryPage<T> {
    require(queryDigest.isNotEmpty() && queryDigest.length <= 256 && '\r' !in queryDigest && '\n' !in queryDigest) {
      "query digest is invalid or too long"
    }
    require(limit in 1..10_000) { "multi-host page limit is outside supported bounds" }
    require(pages.size in 1..256) { "multi-host page count is outside supported bounds" }
    require(pages.map(HostInventoryPage<T>::hostId).distinct().size == pages.size) {
      "multi-host pages contain a duplicate host"
    }

    val ordered = pages.sortedBy { it.hostId.value }
    val offsets = IntArray(ordered.size)
    val merged = mutableListOf<HostInventoryItem<T>>()
    var madeProgress = true
    while (merged.size < limit && madeProgress) {
      madeProgress = false
      for ((index, page) in ordered.withIndex()) {
        if (merged.size >= limit) break
        val offset = offsets[index]
        if (page.safeErrorCode == null && offset < page.items.size) {
          merged += HostInventoryItem(page.hostId, page.items[offset])
          offsets[index] += 1
          madeProgress = true
        }
      }
    }

    val states =
      ordered
        .mapIndexed { index, page ->
          page.hostId to
            HostCursorState(
              nextCursor = page.nextCursor,
              snapshotRevision = page.snapshotRevision,
              exhausted = page.exhausted && offsets[index] == page.items.size,
              safeErrorCode = page.safeErrorCode,
              consumedFromPage = offsets[index],
              pageItemCount = page.items.size,
            )
        }.toMap(linkedMapOf())
    return FairInventoryPage(
      items = merged,
      cursor = MultiHostCursor(queryDigest, states),
      partial = ordered.any { it.safeErrorCode != null },
    )
  }
}
