import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.jetbrains.compose)
  `java-library`
}

kotlin {
  explicitApi()
  jvmToolchain(21)
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_21)
  }
}

dependencies {
  api(compose.runtime)
  api(compose.foundation)
  api(compose.material3)
  implementation(compose.desktop.currentOs)
  implementation(libs.kotlinx.serialization.json)
  testImplementation(compose.desktop.uiTestJUnit4)
  testImplementation(libs.junit.jupiter)
  testRuntimeOnly(libs.junit.platform.launcher)
  testRuntimeOnly(libs.junit.vintage.engine)
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}

tasks.test {
  useJUnitPlatform()
}

compose.desktop {
  application {
    mainClass = "com.harryaskham.pidroid.workspace.WorkspaceFixtureAppKt"
  }
}
