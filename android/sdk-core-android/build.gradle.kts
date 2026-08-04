plugins {
  alias(libs.plugins.android.library)
}

android {
  namespace = "com.harryaskham.pidroid.sdk.core.android"
  compileSdk = 36

  defaultConfig {
    minSdk = 26
    consumerProguardFiles("consumer-rules.pro")
  }

  buildFeatures {
    buildConfig = false
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

androidComponents {
  onVariants(selector().all()) { variant ->
    val kotlinSources = requireNotNull(variant.sources.kotlin)
    kotlinSources.addStaticSourceDirectory("../sdk-core/src/main/kotlin")
    kotlinSources.addStaticSourceDirectory("../sdk-core/src/generated/kotlin")
  }
}

dependencies {
  api(libs.kotlinx.coroutines.core)
  api(libs.kotlinx.serialization.json)
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}
