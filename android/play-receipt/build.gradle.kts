import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.kotlin.jvm)
  application
}

kotlin {
  jvmToolchain(21)
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_21)
  }
}

dependencies {
  implementation(libs.gradle.play.publisher.core)
}

application {
  mainClass = "com.harryaskham.pidroid.release.PlayTrackReceiptKt"
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}

tasks.register("verifyInternalTrackReceipt") {
  group = "publishing"
  description = "Verify the expected version is the highest release on Play internal and write a safe receipt."
  dependsOn(tasks.named("run"))
}
