import org.gradle.api.tasks.Exec

plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.gradle.play.publisher) apply false
  alias(libs.plugins.jetbrains.compose) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.jvm) apply false
}

val repositoryRoot = rootDir.parentFile
val generator = repositoryRoot.resolve("android/build-logic/generate-protocol-models.mjs")

tasks.register<Exec>("generateProtocolModels") {
  group = "build setup"
  description = "Regenerate committed Kotlin protocol contract metadata."
  workingDir(repositoryRoot)
  commandLine("node", generator)
}

tasks.register<Exec>("checkProtocolModels") {
  group = "verification"
  description = "Fail when committed Kotlin protocol contract metadata is stale."
  workingDir(repositoryRoot)
  commandLine("node", generator, "--check")
}
