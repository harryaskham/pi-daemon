import com.android.build.api.dsl.LibraryExtension
import org.gradle.api.publish.PublishingExtension
import org.gradle.api.publish.maven.MavenPublication
import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.bundling.AbstractArchiveTask
import org.gradle.api.tasks.bundling.Jar
import java.util.Properties

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
val sdkPublication =
  Properties().apply {
    rootDir.resolve("sdk-publication.properties").inputStream().use(::load)
  }
val sdkGroup = requireNotNull(sdkPublication.getProperty("group"))
val sdkVersion = requireNotNull(sdkPublication.getProperty("version"))
val sdkArtifacts = requireNotNull(sdkPublication.getProperty("artifacts")).split(',')
val sdkProjects =
  linkedMapOf(
    ":sdk-core-android" to "core",
    ":sdk-session-ui-android" to "session-ui",
    ":sdk-workspace-ui-android" to "workspace-ui",
  )
require(sdkProjects.values.toList() == sdkArtifacts) {
  "sdk-publication.properties artifacts must match the reviewed Android SDK modules"
}
val sdkRepositoryDirectory =
  providers
    .gradleProperty("piDroidSdkRepositoryDir")
    .map(::file)
    .orElse(layout.buildDirectory.dir("sdk-maven-repository").map { it.asFile })

subprojects {
  val sdkArtifact = sdkProjects[path] ?: return@subprojects
  group = sdkGroup
  version = sdkVersion
  pluginManager.apply("maven-publish")

  plugins.withId("com.android.library") {
    extensions.configure<LibraryExtension> {
      publishing {
        singleVariant("release") {
          withSourcesJar()
        }
      }
    }
    afterEvaluate {
      extensions.configure<PublishingExtension> {
        publications {
          create<MavenPublication>("sdkRelease") {
            from(components.getByName("release"))
            artifactId = sdkArtifact
            pom {
              name.set("Pi Droid SDK $sdkArtifact")
              description.set("Cacophony-neutral Pi Daemon Android SDK $sdkArtifact module")
              url.set("https://github.com/harryaskham/pi-daemon")
              licenses {
                license {
                  name.set("MIT License")
                  url.set("https://opensource.org/license/mit")
                  distribution.set("repo")
                }
              }
              scm {
                connection.set("scm:git:https://github.com/harryaskham/pi-daemon.git")
                url.set("https://github.com/harryaskham/pi-daemon")
              }
            }
          }
        }
        repositories {
          maven {
            name = "sdkBundle"
            url = uri(sdkRepositoryDirectory.get())
          }
        }
      }
    }
  }

  tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
  }
  if (sdkArtifact == "workspace-ui") {
    tasks.withType<Jar>().configureEach {
      if (name.contains("source", ignoreCase = true)) {
        exclude("**/WorkspaceFixtureApp.kt")
      }
    }
  }
}

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
