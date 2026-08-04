package com.harryaskham.pidroid.androidui

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** App-owned projection boundary. Implementations resolve local selections through the live repository. */
public interface AndroidWidgetProjectionRepository {
  public fun pinnedProjection(appWidgetId: Int): WidgetProjection?

  public fun collectionProjection(appWidgetId: Int): WidgetCollectionProjection?

  public fun onWidgetsDeleted(appWidgetIds: IntArray) {}
}

/** Process-local adapter installation. A recreated process safely renders unavailable until reinstalled. */
public object AndroidWidgetRuntime {
  @Volatile
  private var installedRepository: AndroidWidgetProjectionRepository? = null

  public val repository: AndroidWidgetProjectionRepository?
    get() = installedRepository

  public fun install(repository: AndroidWidgetProjectionRepository) {
    installedRepository = repository
  }

  public fun clear() {
    installedRepository = null
  }
}

public class PinnedSessionWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    appWidgetIds.forEach { appWidgetId ->
      val projection = AndroidWidgetRuntime.repository?.pinnedProjection(appWidgetId)
      appWidgetManager.updateAppWidget(appWidgetId, pinnedViews(context, appWidgetId, projection))
    }
  }

  override fun onDeleted(
    context: Context,
    appWidgetIds: IntArray,
  ) {
    AndroidWidgetRuntime.repository?.onWidgetsDeleted(appWidgetIds)
  }
}

public class SessionCollectionWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    appWidgetIds.forEach { appWidgetId ->
      val projection = AndroidWidgetRuntime.repository?.collectionProjection(appWidgetId)
      val serviceIntent =
        Intent(context, SessionCollectionRemoteViewsService::class.java)
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
          .setData(Uri.parse("pidroid-widget://collection/$appWidgetId"))
      val views = RemoteViews(context.packageName, R.layout.pidroid_widget_collection)
      views.setRemoteAdapter(R.id.widget_collection_list, serviceIntent)
      views.setEmptyView(R.id.widget_collection_list, R.id.widget_collection_freshness)
      views.setTextViewText(
        R.id.widget_collection_freshness,
        when {
          projection == null -> context.getString(R.string.pidroid_widget_unavailable)
          projection.allFresh -> "All ${projection.projections.size} sessions fresh"
          else -> "${projection.staleCount} of ${projection.projections.size} stale"
        },
      )
      views.setPendingIntentTemplate(R.id.widget_collection_list, openAppTemplate(context, appWidgetId))
      appWidgetManager.updateAppWidget(appWidgetId, views)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.widget_collection_list)
    }
  }

  override fun onDeleted(
    context: Context,
    appWidgetIds: IntArray,
  ) {
    AndroidWidgetRuntime.repository?.onWidgetsDeleted(appWidgetIds)
  }
}

public class SessionCollectionRemoteViewsService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
    val appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    return SessionCollectionFactory(applicationContext, appWidgetId)
  }
}

private class SessionCollectionFactory(
  private val context: Context,
  private val appWidgetId: Int,
) : RemoteViewsService.RemoteViewsFactory {
  private var rows: List<WidgetProjection> = emptyList()

  override fun onCreate() {
    refresh()
  }

  override fun onDataSetChanged() {
    refresh()
  }

  override fun onDestroy() {
    rows = emptyList()
  }

  override fun getCount(): Int = rows.size

  override fun getViewAt(position: Int): RemoteViews? {
    val projection = rows.getOrNull(position) ?: return null
    return RemoteViews(context.packageName, R.layout.pidroid_widget_collection_row).also { views ->
      views.setTextViewText(R.id.widget_collection_row_session, projection.sessionLabel)
      views.setTextViewText(
        R.id.widget_collection_row_context,
        "${projection.hostLabel} · ${projection.freshnessLabel}",
      )
      views.setOnClickFillInIntent(
        R.id.widget_collection_row,
        Intent(Intent.ACTION_VIEW, PiDroidDeepLinkCodec.encode(projection.selection.session).toAndroidDeepLink()),
      )
    }
  }

  override fun getLoadingView(): RemoteViews? = null

  override fun getViewTypeCount(): Int = 1

  override fun getItemId(position: Int): Long =
    rows
      .getOrNull(position)
      ?.selection
      ?.session
      ?.hashCode()
      ?.toLong() ?: position.toLong()

  override fun hasStableIds(): Boolean = true

  private fun refresh() {
    rows =
      AndroidWidgetRuntime.repository
        ?.collectionProjection(appWidgetId)
        ?.projections
        .orEmpty()
  }
}

private fun pinnedViews(
  context: Context,
  appWidgetId: Int,
  projection: WidgetProjection?,
): RemoteViews =
  RemoteViews(context.packageName, R.layout.pidroid_widget_status).also { views ->
    if (projection == null) {
      views.setTextViewText(R.id.widget_host, "PI DROID")
      views.setTextViewText(R.id.widget_session, context.getString(R.string.pidroid_widget_unavailable))
      views.setTextViewText(R.id.widget_freshness, context.getString(R.string.pidroid_widget_stale))
      views.setOnClickPendingIntent(R.id.widget_root, openAppTemplate(context, appWidgetId))
    } else {
      views.setTextViewText(R.id.widget_host, projection.hostLabel)
      views.setTextViewText(R.id.widget_session, projection.sessionLabel)
      views.setTextViewText(R.id.widget_freshness, projection.freshnessLabel)
      views.setOnClickPendingIntent(
        R.id.widget_root,
        PendingIntent.getActivity(
          context,
          appWidgetId,
          Intent(Intent.ACTION_VIEW, PiDroidDeepLinkCodec.encode(projection.selection.session).toAndroidDeepLink())
            .setPackage(context.packageName),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    }
  }

internal fun java.net.URI.toAndroidDeepLink(): Uri {
  require(scheme == PiDroidDeepLinkCodec.DEEP_LINK_SCHEME)
  require(host == "host" && userInfo == null && port == -1)
  require(rawQuery == null && rawFragment == null)
  val segments = rawPath.split('/').filter(String::isNotEmpty)
  require(segments.size == 3 && segments[1] == "session")
  return Uri.parse(toASCIIString())
}

private fun openAppTemplate(
  context: Context,
  requestCode: Int,
): PendingIntent =
  PendingIntent.getActivity(
    context,
    requestCode,
    Intent(Intent.ACTION_VIEW).setPackage(context.packageName),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
