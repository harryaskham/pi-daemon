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

val piDroidAndroidApp = providers.gradleProperty("piDroidAndroidApp").orNull == "true"
val piDroidAndroidSdk = providers.gradleProperty("piDroidAndroidSdk").orNull == "true"

if (piDroidAndroidApp) {
  include(":app")
  include(":play-receipt")
  include(":sdk-android-ui")
}

if (piDroidAndroidApp || piDroidAndroidSdk) {
  include(":sdk-core-android")
  include(":sdk-session-ui-android")
  include(":sdk-workspace-ui-android")
}
