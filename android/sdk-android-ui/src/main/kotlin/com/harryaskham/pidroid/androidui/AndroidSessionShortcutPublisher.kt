package com.harryaskham.pidroid.androidui

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager

/** Publishes only app-owned saved identities; no bearer or remote endpoint enters a shortcut. */
public class AndroidSessionShortcutPublisher(
  context: Context,
  private val manager: ShortcutManager = context.getSystemService(ShortcutManager::class.java),
) {
  private val applicationContext: Context = context.applicationContext

  public fun replace(shortcuts: List<SessionShortcut>) {
    require(shortcuts.size <= MAX_DYNAMIC_SHORTCUTS) { "dynamic shortcut count exceeds bound" }
    require(shortcuts.map(SessionShortcut::shortcutId).toSet().size == shortcuts.size) {
      "dynamic shortcut IDs must be unique"
    }
    val published =
      shortcuts.map { shortcut ->
        ShortcutInfo
          .Builder(applicationContext, shortcut.shortcutId)
          .setShortLabel(shortcut.label)
          .setLongLabel(shortcut.label)
          .setIntent(
            Intent(Intent.ACTION_VIEW, shortcut.deepLink.toAndroidDeepLink())
              .setPackage(applicationContext.packageName),
          ).build()
      }
    check(manager.setDynamicShortcuts(published)) { "Android rejected dynamic shortcuts" }
  }

  public fun clear() {
    manager.removeAllDynamicShortcuts()
  }

  public companion object {
    public const val MAX_DYNAMIC_SHORTCUTS: Int = 8
  }
}
