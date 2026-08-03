import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.kotlin.jvm)
  `java-library`
}

kotlin {
  explicitApi()
  jvmToolchain(21)
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_21)
  }
  sourceSets {
    main {
      kotlin.srcDir("src/generated/kotlin")
    }
  }
}

dependencies {
  api(libs.kotlinx.coroutines.core)
  api(libs.kotlinx.serialization.json)
  testImplementation(libs.junit.jupiter)
  testImplementation(libs.kotlinx.coroutines.test)
  testRuntimeOnly(libs.junit.platform.launcher)
}

dependencyLocking {
  lockAllConfigurations()
  lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}

tasks.named("compileKotlin") {
  dependsOn(rootProject.tasks.named("checkProtocolModels"))
}

tasks.test {
  useJUnitPlatform()
  systemProperty("piDaemon.repositoryRoot", rootProject.rootDir.parentFile.absolutePath)
}
