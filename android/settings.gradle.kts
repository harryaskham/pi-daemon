pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "pi-droid"

include(":sdk-core")
include(":sdk-testing")
include(":sdk-workspace-ui")
include(":sdk-session-ui")
include(":sdk-android-integration")

if (providers.gradleProperty("piDroidAndroidApp").orNull == "true") {
  include(":app")
  include(":play-receipt")
}
