import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// Signing config comes from keystore.properties (git-ignored) or from CI env.
// The APK is sideloaded onto driver phones, so a *stable* signature matters:
// change it and every installed device must uninstall before it can update.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.karahoca.tracker"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.karahoca.tracker"
        minSdk = 26          // Oreo: background execution limits + notification channels
        targetSdk = 35       // Android 15
        /*
         * 18 / 1.4.0 — three releases' worth, because 17 was the last one that
         * actually reached a handset:
         *
         *   - the app on the same design language as the dashboard and the
         *     driver pages, light and dark;
         *   - the language chips on every screen, not only the claim one, so a
         *     driver who picks the wrong flag at the yard gate is not stuck in
         *     a language they cannot read for the rest of the run;
         *   - and the reboot crash: the service missed the ten-second
         *     startForeground deadline during the boot storm and Android killed
         *     the process, so a phone that restarted mid-shipment came back
         *     tracking nothing.
         *
         * Minor rather than patch: the second is a feature and the first is
         * every screen the driver sees.
         */
        versionCode = 18
        versionName = "1.4.0"

        // Baked in so a driver never types a URL. Overridable per build type.
        buildConfigField("String", "DEFAULT_API_BASE_URL",
            "\"${project.findProperty("khApiBaseUrl") ?: "https://track.karahoca.com/api/v1/"}\"")
        buildConfigField("String", "DEEP_LINK_SCHEME", "\"karahoca\"")

        /*
         * The host whose https://<host>/t/<code> links this app claims.
         *
         * It appears twice on purpose: once as a manifest placeholder, which is
         * what Android matches an incoming intent against and what it verifies
         * against /.well-known/assetlinks.json, and once as a BuildConfig field
         * so the code that parses the link can reject a URL from some other
         * host instead of trusting whatever the intent carried.
         *
         * Keep the two in step — a mismatch means the app is launched by a link
         * it then refuses to read, which looks exactly like "the QR does
         * nothing".
         */
        val appLinkHost = (project.findProperty("khAppLinkHost") ?: "track.karahoca.com").toString()
        manifestPlaceholders["appLinkHost"] = appLinkHost
        buildConfigField("String", "APP_LINK_HOST", "\"$appLinkHost\"")

        // ---- Tracking defaults (server can override per session) -------------
        buildConfigField("long", "DEFAULT_PING_INTERVAL_MS", "10000L")
        buildConfigField("long", "DEFAULT_IDLE_INTERVAL_MS", "60000L")
        buildConfigField("long", "REALTIME_FLUSH_INTERVAL_MS", "15000L")
        buildConfigField("int",  "SYNC_BATCH_SIZE", "500")
        buildConfigField("int",  "BUFFER_MAX_ROWS", "500000")

        vectorDrawables.useSupportLibrary = true
    }

    signingConfigs {
        create("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            } else {
                storeFile = System.getenv("KH_KEYSTORE_PATH")?.let { file(it) }
                storePassword = System.getenv("KH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KH_KEY_ALIAS")
                keyPassword = System.getenv("KH_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isMinifyEnabled = false
            buildConfigField("String", "DEFAULT_API_BASE_URL",
                "\"${project.findProperty("khApiBaseUrlDebug") ?: "http://10.0.2.2:4000/api/v1/"}\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // java.time on API 26 devices
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs += listOf(
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
        )
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/DEPENDENCIES",
            "META-INF/*.version",
        )
    }

    // Drivers install this by hand over a phone hotspot. One universal APK,
    // no split, no bundle — the file must always be the same file.
    splits { abi { isEnable = false } }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged manifest and resources to stand up
            // an Application context.
            isIncludeAndroidResources = true
            all { it.systemProperty("robolectric.logging", "stdout") }
        }
    }
}

/*
 * Room exports its schema as JSON so every migration can be diffed in review.
 * TrackerDatabase deliberately has no fallbackToDestructiveMigration — a
 * destructive migration on app update would delete buffered points that never
 * reached the server — so a schema change without a Migration must be visible
 * in the diff.
 */
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.incremental", "true")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)

    // Local buffer — the component that makes "never lose a coordinate" true
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // Deferred, constraint-aware sync
    implementation(libs.work.runtime)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.work)
    ksp(libs.hilt.work.compiler)
    implementation(libs.hilt.navigation.compose)

    implementation(libs.datastore.preferences)
    implementation(libs.security.crypto)

    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    debugImplementation(libs.okhttp.logging)

    implementation(libs.coroutines.android)
    implementation(libs.coroutines.play.services)

    // FusedLocationProviderClient: sensor fusion + OS-level batching we control
    implementation(libs.play.services.location)
    // GoogleApiAvailability — the readiness checklist must fail closed on a
    // de-Googled or Huawei phone rather than run a silent 14-hour shift.
    implementation(libs.play.services.base)

    // QR scanning for the session hand-off
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.mlkit.barcode)

    coreLibraryDesugaring(libs.desugar.jdk.libs)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.coroutines.test)
}
