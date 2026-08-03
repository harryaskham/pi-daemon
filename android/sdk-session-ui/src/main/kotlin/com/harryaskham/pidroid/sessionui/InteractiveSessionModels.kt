package com.harryaskham.pidroid.sessionui

import com.harryaskham.pidroid.sdk.core.CacheFreshness
import com.harryaskham.pidroid.sdk.core.HostAuthority
import com.harryaskham.pidroid.sdk.core.SessionRole

private val INTERACTIVE_IDENTIFIER = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

public class InteractiveSurfaceException(
  public val code: String,
  message: String,
) : IllegalArgumentException(message)

public data class InteractiveSessionIdentity(
  public val authority: HostAuthority,
  public val sessionId: String,
  public val generation: Int,
) {
  init {
    require(INTERACTIVE_IDENTIFIER.matches(sessionId)) { "session ID must be a bounded identifier" }
    require(generation >= 0) { "session generation must be non-negative" }
  }
}

public data class InteractionContext(
  public val identity: InteractiveSessionIdentity,
  public val role: SessionRole,
  public val freshness: CacheFreshness,
)

public sealed interface InteractionDecision<out T> {
  public data class Ready<T>(
    public val intent: T,
  ) : InteractionDecision<T>

  public data class Blocked(
    public val reason: String,
  ) : InteractionDecision<Nothing>
}

public enum class SessionTreeEntryKind {
  SYSTEM,
  USER,
  ASSISTANT,
  TOOL,
  UNKNOWN,
}

public data class SessionTreeEntry(
  public val id: String,
  public val parentId: String?,
  public val kind: SessionTreeEntryKind,
  public val label: String,
  public val active: Boolean,
) {
  init {
    require(INTERACTIVE_IDENTIFIER.matches(id)) { "tree entry ID must be a bounded identifier" }
    require(parentId == null || INTERACTIVE_IDENTIFIER.matches(parentId)) { "tree parent ID must be a bounded identifier" }
    require(label.isNotBlank() && label.length <= 256 && '\n' !in label && '\r' !in label) {
      "tree entry label must be bounded single-line text"
    }
    require(parentId != id) { "tree entry cannot parent itself" }
  }
}

public data class SessionTreeSnapshot(
  public val identity: InteractiveSessionIdentity,
  public val entries: List<SessionTreeEntry>,
  public val activeEntryId: String,
) {
  init {
    require(entries.isNotEmpty() && entries.size <= MAX_ENTRIES) { "tree entry count is outside the supported bound" }
    require(INTERACTIVE_IDENTIFIER.matches(activeEntryId)) { "active tree entry ID is invalid" }
    val byId = entries.associateBy(SessionTreeEntry::id)
    require(byId.size == entries.size) { "tree entry IDs must be unique" }
    require(byId.keys.containsAll(entries.mapNotNull(SessionTreeEntry::parentId))) { "tree parent is missing" }
    require(entries.count { it.parentId == null } == 1) { "tree must have exactly one root" }
    require(entries.count(SessionTreeEntry::active) == 1 && byId[activeEntryId]?.active == true) {
      "tree active entry is inconsistent"
    }
    for (entry in entries) {
      val visited = mutableSetOf<String>()
      var cursor: SessionTreeEntry? = entry
      while (cursor != null) {
        require(visited.add(cursor.id)) { "tree contains a parent cycle" }
        cursor = cursor.parentId?.let(byId::get)
      }
    }
  }

  public companion object {
    public const val MAX_ENTRIES: Int = 256
  }
}

public data class SessionTreeRow(
  public val entry: SessionTreeEntry,
  public val depth: Int,
  public val accessibilityLabel: String,
)

public object SessionTreeProjection {
  public fun rows(snapshot: SessionTreeSnapshot): List<SessionTreeRow> {
    val children = snapshot.entries.groupBy(SessionTreeEntry::parentId)
    val rows = mutableListOf<SessionTreeRow>()

    fun visit(
      entry: SessionTreeEntry,
      depth: Int,
    ) {
      require(depth <= SessionTreeSnapshot.MAX_ENTRIES) { "tree depth exceeds entry bound" }
      rows +=
        SessionTreeRow(
          entry = entry,
          depth = depth,
          accessibilityLabel =
            "Branch entry ${entry.label}, depth $depth, ${if (entry.active) "active" else "inactive"}",
        )
      children[entry.id].orEmpty().forEach { visit(it, depth + 1) }
    }
    visit(snapshot.entries.single { it.parentId == null }, 0)
    require(rows.size == snapshot.entries.size) { "tree contains unreachable entries" }
    return rows
  }
}

public class TreeNavigationIntent(
  public val identity: InteractiveSessionIdentity,
  public val correlationId: String,
  public val entryId: String,
  public val summarize: Boolean,
  public val customInstructions: String?,
  public val label: String?,
) {
  init {
    require(INTERACTIVE_IDENTIFIER.matches(correlationId)) { "tree correlation ID is invalid" }
    require(INTERACTIVE_IDENTIFIER.matches(entryId)) { "tree target entry ID is invalid" }
    require(customInstructions == null || customInstructions.length <= 4_096) { "tree custom instructions exceed bound" }
    require(label == null || (label.length <= 128 && INTERACTIVE_IDENTIFIER.matches(label))) { "tree navigation label is invalid" }
  }

  override fun toString(): String =
    "TreeNavigationIntent(session=${identity.sessionId}, generation=${identity.generation}, correlationId=$correlationId, entryId=$entryId, summarize=$summarize, customInstructions=[REDACTED])"
}

public class TreeNavigationResult(
  public val correlationId: String,
  public val cancelled: Boolean,
  public val editorText: String?,
  public val summaryEntryId: String?,
) {
  override fun toString(): String =
    "TreeNavigationResult(correlationId=$correlationId, cancelled=$cancelled, summaryEntryId=$summaryEntryId, editorText=[REDACTED])"
}

public object SessionTreeAuthority {
  public fun authorize(
    snapshot: SessionTreeSnapshot,
    intent: TreeNavigationIntent,
    context: InteractionContext,
  ): InteractionDecision<TreeNavigationIntent> {
    if (snapshot.identity != intent.identity || snapshot.identity != context.identity) {
      return InteractionDecision.Blocked("identity_mismatch")
    }
    if (context.role != SessionRole.CONTROLLER) return InteractionDecision.Blocked("controller_required")
    if (context.freshness != CacheFreshness.FRESH) return InteractionDecision.Blocked("freshness_required")
    val target =
      snapshot.entries.firstOrNull { it.id == intent.entryId }
        ?: return InteractionDecision.Blocked("entry_not_found")
    if (target.active) return InteractionDecision.Blocked("already_active")
    return InteractionDecision.Ready(intent)
  }
}
