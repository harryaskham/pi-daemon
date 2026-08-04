plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.jetbrains.compose)
}

android {
  namespace = "com.harryaskham.pidroid.sessionui.android"
  compileSdk = 36

  defaultConfig {
    minSdk = 26
    consumerProguardFiles("consumer-rules.pro")
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

androidComponents {
  onVariants(selector().all()) { variant ->
    requireNotNull(variant.sources.kotlin)
      .addStaticSourceDirectory("../sdk-session-ui/src/main/kotlin")
  }
}

dependencies {
  api(project(":sdk-core-android"))
  api(compose.runtime)
  api(compose.foundation)
  api(compose.material3)
  implementation(libs.kotlinx.serialization.json)
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}
