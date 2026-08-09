package com.harryaskham.pidroid.live

import com.harryaskham.pidroid.sdk.core.ConfiguredSessionPersistence
import com.harryaskham.pidroid.sdk.core.HostId
import com.harryaskham.pidroid.sdk.core.SessionKey
import com.harryaskham.pidroid.sdk.core.TicketState

/** Content-safe create policy projected from the daemon's exact advertised defaults. */
public class LiveCreateSessionDefaults(
  public val cwd: String,
  public val persistence: ConfiguredSessionPersistence,
  public val provider: String?,
  public val modelId: String?,
  public val thinkingLevel: String?,
  public val toolMode: String,
  public val projectTrust: String,
  public val authoritySource: String,
) {
  override fun toString(): String =
    "LiveCreateSessionDefaults(cwd=[SERVER-CONFIGURED], persistence=$persistence, model=${modelId != null}, toolMode=$toolMode, projectTrust=$projectTrust, authoritySource=$authoritySource)"
}

public data class LiveSessionCatalogItem(
  public val inventoryId: String,
  public val title: String,
  public val projectLabel: String?,
  public val cwdBasename: String?,
  public val managedSession: SessionKey?,
  public val state: String,
  public val unread: Boolean,
  public val activityAt: String?,
  public val canAdopt: Boolean,
  public val adoptionReasonCode: String?,
)

public data class LiveSessionCatalog(
  public val items: List<LiveSessionCatalogItem>,
  public val selectedInventoryId: String?,
  public val createDefaults: LiveCreateSessionDefaults?,
  public val inventoryStale: Boolean,
  public val inventoryReconciling: Boolean,
  public val retainedSessionCount: Int,
)

public enum class LiveSessionActionKind {
  CREATE,
  ADOPT,
}

public enum class LiveSessionActionEndpoint {
  SESSION_TICKET,
  ACTIVATION_TICKET,
}

/**
 * Process-safe bookmark written before a mutation crosses transport authority.
 *
 * It deliberately contains no bearer, cwd, prompt, model output, transcript, command body, result,
 * or arbitrary server error. A bookmark without [ticketId] is indeterminate and must never be
 * replayed merely because the app process restarted.
 */
public data class LiveSessionActionBookmark(
  public val hostId: HostId,
  public val kind: LiveSessionActionKind,
  public val endpoint: LiveSessionActionEndpoint,
  public val requestId: String,
  public val idempotencyKey: String,
  public val inventoryId: String?,
  public val ticketId: String?,
)

public sealed interface LiveSessionActionState {
  public data object Idle : LiveSessionActionState

  public data class Working(
    public val kind: LiveSessionActionKind,
  ) : LiveSessionActionState

  public data class Accepted(
    public val bookmark: LiveSessionActionBookmark,
    public val state: TicketState,
    public val session: SessionKey?,
  ) : LiveSessionActionState

  public data class Completed(
    public val kind: LiveSessionActionKind,
    public val session: SessionKey,
  ) : LiveSessionActionState

  public data class Indeterminate(
    public val bookmark: LiveSessionActionBookmark,
  ) : LiveSessionActionState

  public data class Failure(
    public val kind: LiveSessionActionKind,
    public val code: String,
    public val retryable: Boolean,
  ) : LiveSessionActionState
}

/** Only content-free navigation and mutation identities survive Android process death. */
public interface DailyDriverStore {
  public suspend fun readSelectedInventory(hostId: HostId): String?

  public suspend fun writeSelectedInventory(
    hostId: HostId,
    inventoryId: String?,
  )

  public suspend fun readActionBookmark(): LiveSessionActionBookmark?

  public suspend fun writeActionBookmark(bookmark: LiveSessionActionBookmark?)

  /** Strict [com.harryaskham.pidroid.sdk.core.SessionResumeSnapshotCodec] bytes only. */
  public suspend fun readInteractiveResume(): ByteArray?

  public suspend fun writeInteractiveResume(encoded: ByteArray?)
}

internal class EphemeralDailyDriverStore : DailyDriverStore {
  private val selected = linkedMapOf<HostId, String>()
  private var bookmark: LiveSessionActionBookmark? = null
  private var interactiveResume: ByteArray? = null

  override suspend fun readSelectedInventory(hostId: HostId): String? = selected[hostId]

  override suspend fun writeSelectedInventory(
    hostId: HostId,
    inventoryId: String?,
  ) {
    if (inventoryId == null) selected.remove(hostId) else selected[hostId] = inventoryId
  }

  override suspend fun readActionBookmark(): LiveSessionActionBookmark? = bookmark

  override suspend fun writeActionBookmark(bookmark: LiveSessionActionBookmark?) {
    this.bookmark = bookmark
  }

  override suspend fun readInteractiveResume(): ByteArray? = interactiveResume?.copyOf()

  override suspend fun writeInteractiveResume(encoded: ByteArray?) {
    interactiveResume = encoded?.copyOf()
  }
}
