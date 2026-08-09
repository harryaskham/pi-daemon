package com.harryaskham.pidroid

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.harryaskham.pidroid.workspace.PiDroidColorSchemes
import com.harryaskham.pidroid.workspace.PiDroidUxTheme

@Composable
internal fun PiDroidAppTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
  dynamicColor: Boolean = true,
  content: @Composable () -> Unit,
) {
  val context = LocalContext.current
  val colors: ColorScheme =
    when {
      dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && darkTheme -> dynamicDarkColorScheme(context)
      dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> dynamicLightColorScheme(context)
      darkTheme -> PiDroidColorSchemes.Dark
      else -> PiDroidColorSchemes.Light
    }
  PiDroidUxTheme(colorScheme = colors, content = content)
}
