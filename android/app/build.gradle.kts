import com.github.triplet.gradle.androidpublisher.ResolutionStrategy
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile
import java.io.File

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.jetbrains.compose)
  alias(libs.plugins.gradle.play.publisher)
}

val releaseTasks =
  gradle.startParameter.taskNames.any { task ->
    task.contains("bundleRelease", ignoreCase = true) ||
      task.contains("assembleRelease", ignoreCase = true) ||
      task.contains("publishRelease", ignoreCase = true)
  }

fun requiredEnvironmentFile(name: String): File {
  val path =
    providers.environmentVariable(name).orNull
      ?: throw GradleException("$name must point to a private release file")
  val candidate = file(path)
  if (!candidate.isFile) {
    throw GradleException("$name does not name a readable release file")
  }
  return candidate
}

fun secretFileText(name: String): String =
  providers
    .fileContents(layout.file(providers.provider { requiredEnvironmentFile(name) }))
    .asText
    .get()
    .trimEnd()

android {
  namespace = "com.harryaskham.pidroid"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.harryaskham.pidroid"
    minSdk = 26
    targetSdk = 36
    versionCode = providers.gradleProperty("piDroidVersionCode").getOrElse("4").toInt()
    versionName = providers.gradleProperty("piDroidVersionName").getOrElse("0.3.0-internal.4")
  }

  sourceSets.named("main") {
    kotlin.directories += "../sdk-core/src/generated/kotlin"
    kotlin.directories += "../sdk-core/src/main/kotlin"
    kotlin.directories += "../sdk-session-ui/src/main/kotlin"
    kotlin.directories += "../sdk-workspace-ui/src/main/kotlin"
    kotlin.directories += "../sdk-android-integration/src/main/kotlin"
  }

  if (releaseTasks) {
    signingConfigs {
      create("release") {
        storeFile = requiredEnvironmentFile("PI_DROID_RELEASE_KEYSTORE")
        keyAlias = secretFileText("PI_DROID_RELEASE_KEY_ALIAS_FILE")
        storePassword = secretFileText("PI_DROID_RELEASE_STORE_PASSWORD_FILE")
        keyPassword = secretFileText("PI_DROID_RELEASE_KEY_PASSWORD_FILE")
        enableV1Signing = true
        enableV2Signing = true
      }
    }
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      versionNameSuffix = "-debug"
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
      if (releaseTasks) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }

  buildFeatures {
    compose = true
    buildConfig = false
  }

  testOptions {
    unitTests.isReturnDefaultValues = true
  }

  packaging {
    resources.excludes +=
      setOf(
        "/META-INF/{AL2.0,LGPL2.1}",
        "/META-INF/versions/**",
      )
  }
}

dependencies {
  implementation(libs.activity.compose)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.okhttp)
  implementation(compose.runtime)
  implementation(compose.foundation)
  implementation(compose.material3)
  testImplementation(libs.junit.jupiter)
  testImplementation(libs.kotlinx.coroutines.test.android)
  testImplementation(libs.mockwebserver)
  testImplementation(libs.okhttp.tls)
  testRuntimeOnly(libs.junit.platform.launcher)
}

val playCredentials =
  providers
    .environmentVariable("PI_DROID_PLAY_SERVICE_ACCOUNT_FILE")
    .orElse(layout.buildDirectory.file("missing-play-service-account.json").map { it.asFile.absolutePath })

play {
  serviceAccountCredentials.set(file(playCredentials.get()))
  track.set("internal")
  defaultToAppBundles.set(true)
  resolutionStrategy.set(ResolutionStrategy.IGNORE)
}

tasks.withType<Test>().configureEach {
  useJUnitPlatform()
  systemProperty("piDaemon.repositoryRoot", rootProject.rootDir.parentFile.absolutePath)
}

tasks.withType<KotlinCompile>().configureEach {
  exclude("**/WorkspaceFixtureApp.kt")
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}
