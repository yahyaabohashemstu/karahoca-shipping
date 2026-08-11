# =============================================================================
# KaraHoca Tracker — R8 rules
# =============================================================================

# --- kotlinx.serialization ----------------------------------------------------
# R8 strips the synthetic $serializer classes because nothing references them
# statically. Without these rules every DTO throws SerializationException in
# release only — the classic "works in debug, dead in the field" failure.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers @kotlinx.serialization.Serializable class ** {
    static <1>$Companion Companion;
    static **$* *;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.karahoca.tracker.**$$serializer { *; }
-keepclassmembers class com.karahoca.tracker.** {
    *** Companion;
}

# --- Retrofit / OkHttp --------------------------------------------------------
-keepattributes Signature, Exceptions, RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-if interface * { @retrofit2.http.* public *** *(...); }
-keep,allowoptimization,allowshrinking,allowobfuscation interface <1>

-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Room ---------------------------------------------------------------------
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep @androidx.room.Entity class * { *; }
-dontwarn androidx.room.paging.**

# --- WorkManager --------------------------------------------------------------
# Workers are instantiated reflectively by name.
-keep class * extends androidx.work.ListenableWorker { <init>(...); }
-keep class com.karahoca.tracker.sync.SyncWorker { *; }

# --- Hilt ---------------------------------------------------------------------
-keep class dagger.hilt.** { *; }
-keep class javax.inject.** { *; }
-keep class * extends dagger.hilt.android.internal.managers.ViewComponentManager$FragmentContextWrapper

# --- Our components -----------------------------------------------------------
# Declared in the manifest and started by the system; must keep their names or
# the watchdog's ComponentName lookups and BOOT_COMPLETED delivery both fail.
-keep class com.karahoca.tracker.service.LocationTrackingService { *; }
-keep class com.karahoca.tracker.service.BootReceiver { *; }
-keep class com.karahoca.tracker.service.WatchdogReceiver { *; }
-keep class com.karahoca.tracker.service.NotificationActionReceiver { *; }
-keep class com.karahoca.tracker.TrackerApplication { *; }
-keep class com.karahoca.tracker.ui.MainActivity { *; }

# --- Play Services location ---------------------------------------------------
-keep class com.google.android.gms.location.** { *; }
-dontwarn com.google.android.gms.**

# --- Keep line numbers for crash triage from the field ------------------------
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile
