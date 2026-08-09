plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.plugin.compose")
  id("org.jetbrains.compose")
}

android {
  namespace = "com.harryaskham.pidroid.sdk.consumer.sample"
  compileSdk = 36

  defaultConfig {
    minSdk = 26
  }

  buildFeatures {
    buildConfig = false
    compose = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

dependencies {
  implementation("com.harryaskham.pidroid.sdk:core:0.3.0-alpha.2")
  implementation("com.harryaskham.pidroid.sdk:session-ui:0.3.0-alpha.2")
  implementation("com.harryaskham.pidroid.sdk:workspace-ui:0.3.0-alpha.2")
}
