package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness

public object SessionSurfaceReducer {
  public fun withFreshness(
    state: SessionSurfaceState,
    freshness: CacheFreshness,
    observedAgeMillis: Long,
  ): SessionSurfaceState {
    require(observedAgeMillis >= 0) { "observed age must be non-negative" }
    val host =
      state.host.copy(
        freshness = freshness,
        observedAgeMillis = observedAgeMillis,
      )
    return SessionSurfaceState(
      host = host,
      inventory = state.inventory,
      session = state.session,
      records = state.records,
      mode = SessionSurfaceMode.READONLY,
      freshnessLabel = freshnessLabel(freshness, observedAgeMillis),
      canMutate = false,
      retainedRecordLimit = state.retainedRecordLimit,
    )
  }

  public fun freshnessLabel(
    freshness: CacheFreshness,
    observedAgeMillis: Long,
  ): String {
    val age = formatAge(observedAgeMillis)
    return when (freshness) {
      CacheFreshness.FRESH -> "Live"
      CacheFreshness.RECONNECTING -> "Reconnecting · $age"
      CacheFreshness.STALE -> "Stale · $age"
      CacheFreshness.RESYNCING -> "Resyncing · $age"
      CacheFreshness.OFFLINE_CACHED -> "Offline cached · $age"
      CacheFreshness.REMOVED -> "Removed"
    }
  }

  private fun formatAge(observedAgeMillis: Long): String =
    when {
      observedAgeMillis < 1_000 -> "now"
      observedAgeMillis < 60_000 -> "${observedAgeMillis / 1_000}s"
      observedAgeMillis < 3_600_000 -> "${observedAgeMillis / 60_000}m"
      else -> "${observedAgeMillis / 3_600_000}h"
    }
}
