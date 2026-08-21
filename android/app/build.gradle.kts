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
         * 21 / 1.7.0 — a release that reaches a phone the same day.
         *
         * 1.6.0 went out and nothing appeared on the handset watching for it.
         * Nothing was broken: the background check is throttled, the phone had
         * looked an hour earlier, and the next look was five hours away. From
         * the outside that is indistinguishable from a button that does not
         * work — which is the worst property a release mechanism can have.
         *
         * Three paths now, shortest first: opening the app always checks; a
         * tracking phone is told on its next telemetry response, within
         * seconds; and the background timer is an hour rather than six. The app
         * also identifies itself when it checks, so the dashboard can show
         * whether any phone came to look at all.
         */
        versionCode = 21
        versionName = "1.7.0"

        /*
         * 20 / 1.6.0 — the shipment a driver stopped by mistake.
         *
         * Stopping is the one action on this phone that nothing recovers from:
         * it clears the flag, cancels the watchdog and parks the session, and
         * every resurrection mechanism correctly stands down, because from the
         * inside a stop is indistinguishable from a driver who meant it. The
         * same action also sat on the ongoing notification, reachable from the
         * lock screen of a phone in a door pocket.
         *
         * So it asks now — and if it happens anyway, a dispatcher can undo it:
         * the server raises PAUSED_TOO_LONG after ten minutes, and pressing
         * Resume reaches the phone through the session check here.
         */
        /*
         * 19 / 1.5.0 — the last release that has to be installed by hand.
         *
         * From here the app checks /downloads/latest.json twice a shift, says
         * so in a notification that comes back if it is dismissed, and installs
         * the new build from a button inside itself. Before this, the only
         * route from a fixed bug to a driver's phone was a telephone call and a
         * talk-through, and three releases in a row failed to make the trip.
         *
         * 18 / 1.4.0 was the redesign, the language chips on every screen, and
         * the reboot crash — a phone that restarted mid-shipment came back
         * tracking nothing because the service missed the ten-second
         * startForeground deadline during the boot storm.
         */

        // Baked in so a driver never types a URL. Overridable per build type.
        buildConfigField("String", "DEFAULT_API_BASE_URL",
            "\"${project.findProperty("khApiBaseUrl") ?: "https://track.karahoca.com/api/v1/"}\"")
        buildConfigField("String", "DEEP_LINK_SCHEME", "\"karahoca\"")

        /*
         * Where the app looks to find out that it is out of date.
         *
         * A static file beside the APK rather than an API endpoint, because it
         * is written by the same command that swaps the APK into place and so
         * cannot advertise a version the download does not contain. Overridable
         * for the same reason khApiBaseUrl is: to point a release-configuration
         * build at a local stub and watch it update itself.
         */
        buildConfigField("String", "UPDATE_MANIFEST_URL",
            "\"${project.findProperty("khUpdateManifestUrl")
                ?: "https://track.karahoca.com/downloads/latest.json"}\"")

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
