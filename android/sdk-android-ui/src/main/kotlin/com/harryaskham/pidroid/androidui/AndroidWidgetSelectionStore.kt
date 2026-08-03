package com.harryaskham.pidroid.androidui

import android.content.Context

/** Credential-free durable widget choices; live authority is always resolved from the repository. */
public class AndroidWidgetSelectionStore(
  context: Context,
) {
  private val preferences =
    context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  public fun save(
    appWidgetId: Int,
    selection: WidgetSelection,
  ) {
    require(appWidgetId >= 0) { "app widget ID is invalid" }
    preferences.edit().putString(key(appWidgetId), WidgetSelectionCodec.encode(selection)).apply()
  }

  public fun load(appWidgetId: Int): WidgetSelection? = preferences.getString(key(appWidgetId), null)?.let(WidgetSelectionCodec::decode)

  public fun delete(appWidgetIds: IntArray) {
    preferences
      .edit()
      .also { editor ->
        appWidgetIds.forEach { appWidgetId -> editor.remove(key(appWidgetId)) }
      }.apply()
  }

  private fun key(appWidgetId: Int): String = "widget-$appWidgetId"

  private companion object {
    const val PREFERENCES_NAME: String = "pidroid-widget-selections-v1"
  }
}
