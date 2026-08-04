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
    maven {
      name = "piDroidSdkBundle"
      url = uri(providers.gradleProperty("piDroidSdkRepositoryDir").get())
      content {
        includeGroup("com.harryaskham.pidroid.sdk")
      }
    }
  }
}

rootProject.name = "pi-droid-sdk-consumer-sample"
include(":consumer")
