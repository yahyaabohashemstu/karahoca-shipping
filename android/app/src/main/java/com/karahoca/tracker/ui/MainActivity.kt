package com.karahoca.tracker.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.core.app.ActivityCompat
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.karahoca.tracker.ui.theme.KaraHocaTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.Dp
import com.karahoca.tracker.ui.theme.status
import com.karahoca.tracker.util.ClaimCode
import com.karahoca.tracker.util.CrashReporter
import com.karahoca.tracker.util.LocationSettingsHelper
import com.karahoca.tracker.util.PowerHelper
import dagger.hilt.android.AndroidEntryPoint
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import androidx.compose.ui.res.stringResource
import com.karahoca.tracker.R
import com.karahoca.tracker.util.AppLocale
import com.karahoca.tracker.util.DistanceUnit
import com.karahoca.tracker.util.formatRemaining

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    /*
     * The chosen language, applied before a single string is read.
     *
     * attachBaseContext runs ahead of onCreate, which is the only point early
     * enough — a Compose tree that has already resolved its strings does not
     * re-resolve them because the configuration changed underneath it.
     *
     * On API 33+ the platform applies the chosen locale to this activity by
     * itself and the wrap is a no-op; below 33 there is no such mechanism and
     * the wrap is the entire feature. See AppLocale.
     */
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLocale.wrap(newBase))
    }

    /*
     * mutableStateOf, not a plain var — and this is the difference between the
     * QR working and not working.
     *
     * As a plain field, a write from onNewIntent did not invalidate the
     * composition, so LaunchedEffect(pendingDeepLinkCode) never saw the new
     * key and the scan was dropped. It appeared to work only because the
     * 2-second state poll happened to recompose for some other reason, and
     * only when that poll produced a StateFlow value that differed from the
     * last one — on an idle claim screen it usually does not.
     *
     * That is exactly the path the App Link made common: this activity is
     * singleTask, so a driver who already has the app open and then scans the
     * dispatch note arrives through onNewIntent, not onCreate.
     */
    private var pendingDeepLinkCode by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingDeepLinkCode = extractCode(intent)

        setContent {
            KaraHocaTheme {
                val viewModel: TrackerViewModel = hiltViewModel()
                val state by viewModel.state.collectAsStateWithLifecycle()

                LaunchedEffect(pendingDeepLinkCode) {
                    pendingDeepLinkCode?.let {
                        viewModel.onDeepLinkCode(it)
                        pendingDeepLinkCode = null
                    }
                }

                // Read once per composition of the root, not on every recompose.
                val context = LocalContext.current
                var crash by remember { mutableStateOf(CrashReporter.lastReport(context)) }

                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxSize()) {
                        // The previous run died. Show it, and let the driver
                        // send it — on a driver's phone this is the only
                        // channel we have for a stack trace.
                        crash?.let { report ->
                            CrashBanner(
                                report = report,
                                onShare = { shareText(context, report) },
                                onDismiss = { CrashReporter.clear(context); crash = null },
                            )
                        }
                        // weight(1f), not the children's fillMaxSize(): a child
                        // that fills the whole column would overflow it once the
                        // banner takes vertical space, pushing the UI off-screen.
                        Box(Modifier.weight(1f)) {
                            when (state.screen) {
                                TrackerUiState.Screen.CLAIM -> ClaimScreen(state, viewModel)
                                TrackerUiState.Screen.READINESS -> ReadinessScreen(state, viewModel)
                                TrackerUiState.Screen.TRACKING -> TrackingScreen(state, viewModel)
                            }
                        }
                    }
                }
            }
        }
    }

    /** singleTask: a QR scan while the app is already open arrives here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Only overwrite on a code. A plain relaunch — the launcher icon, a
        // notification tap — delivers an intent with no data, and assigning its
        // null would discard a scan that has not been consumed yet.
        extractCode(intent)?.let { pendingDeepLinkCode = it }
    }

    /**
     * Both hand-off shapes, one parser.
     *
     * The printed QR now carries `https://<host>/t/<code>` — a verified App
     * Link, which is the only form Android camera apps will open directly —
     * while `karahoca://track?c=<code>` still arrives from the landing page's
     * intent:// fallback and from SMS. ClaimCode.fromLink knows both, checks
     * the host, and returns null for anything else that gets thrown at this
     * exported activity.
     */
    private fun extractCode(intent: Intent?): String? =
        intent?.takeIf { it.action == Intent.ACTION_VIEW }?.let { ClaimCode.fromLink(it.data) }
}

// =============================================================================
// Screens
// =============================================================================
/*
 * All three screens are built from four shapes and nothing else: a hero, a
 * labelled section, a row, and one primary action at the foot. That is the same
 * vocabulary the dispatcher's dashboard and the consignee's page use, and it is
 * why they now look like one product rather than three that happen to share a
 * logo.
 *
 * Every colour comes from the theme. There were seven hexes written inline in
 * this file — 0xFF16A34A twice, 0xFF7F1D1D, 0xFFF59E0B three times — which is
 * how the "satisfied" green on the readiness list ended up a different green
 * from the "online" green two screens later.
 */

@Composable
private fun ClaimScreen(state: TrackerUiState, viewModel: TrackerViewModel) {
    Box(Modifier.fillMaxSize()) {
        BrandWash()

        /*
         * Centred, and it has to be a Box rather than an arrangement on the
         * scrolling Column.
         *
         * `verticalArrangement = Center` inside `verticalScroll` does nothing:
         * the scroll modifier measures its child with an unbounded height, so
         * the Column is exactly as tall as its contents and there is no spare
         * space to distribute. The scroll goes on the Box, the Column sizes to
         * its contents, and the Box centres it — which leaves the screen
         * balanced when it fits and scrolls normally when it does not.
         *
         * imePadding, because centring moves the code field down the screen and
         * the keyboard comes up from the bottom. The activity is already
         * adjustResize; this is what turns that into an inset Compose respects.
         */
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 22.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Spacer(Modifier.height(8.dp))
            BrandMark(52.dp)
            Spacer(Modifier.height(14.dp))
            Text(
                "KARAHOCA",
                style = MaterialTheme.typography.labelMedium,
                letterSpacing = 4.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                stringResource(R.string.claim_heading),
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(26.dp))

            /*
             * The code, the error and the button in one sheet.
             *
             * They were four loose elements on the background before, at which
             * point the screen was a heading and a scatter. A driver who has
             * just scanned a printed sheet at a loading dock is looking for one
             * thing to do; putting the field and its button inside a single
             * raised object is what makes that one thing findable.
             */
            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                shadowElevation = 2.dp,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(20.dp)) {
                    Text(
                        stringResource(R.string.claim_hint),
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(18.dp))

                    OutlinedTextField(
                        value = state.codeInput,
                        onValueChange = viewModel::onCodeChanged,
                        label = { Text(stringResource(R.string.claim_field_label)) },
                        placeholder = { Text("K7H2-9QX4") },
                        singleLine = true,
                        isError = state.error != null,
                        shape = MaterialTheme.shapes.small,
                        textStyle = TextStyle(
                            fontSize = 28.sp,
                            fontFamily = FontFamily.Monospace,
                            // 6sp of tracking pushed a formatted 9-character code
                            // past the field on a 5" phone, and the dash is the
                            // character that goes missing first. Enough to keep the
                            // groups legible, not enough to overflow.
                            letterSpacing = 3.sp,
                            textAlign = TextAlign.Center,
                        ),
                        // The dash appears by itself after the fourth character. It
                        // is painted, not typed: what the state holds stays 8 clean
                        // characters. See ClaimCodeTransformation.
                        visualTransformation = remember { ClaimCodeTransformation() },
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(onGo = { if (state.canClaim) viewModel.claim() }),
                        modifier = Modifier.fillMaxWidth(),
                    )

                    state.error?.let {
                        Spacer(Modifier.height(12.dp))
                        Notice(tone = NoticeTone.DANGER, text = it)
                    }

                    Spacer(Modifier.height(18.dp))
                    Button(
                        onClick = viewModel::claim,
                        enabled = !state.busy && state.canClaim,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(54.dp),
                    ) {
                        if (state.busy) {
                            CircularProgressIndicator(
                                Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                        } else {
                            Text(
                                stringResource(R.string.claim_submit),
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(26.dp))
            LanguagePicker()
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** Hand a stack trace to WhatsApp/e-mail — the only support channel a driver has. */
private fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, "KaraHoca Takip — hata raporu")
        putExtra(Intent.EXTRA_TEXT, text.take(60_000))
    }
    context.startActivity(Intent.createChooser(send, context.getString(R.string.crash_send)))
}

/**
 * Shown when the previous run crashed.
 *
 * Deliberately loud and deliberately copyable. Without it the entire bug report
 * from the field is "it closed by itself", and the process is gone before it
 * could ever upload anything.
 *
 * The one place in the app that still ignores the surface palette, and on
 * purpose: it has to be unmistakable the moment the app opens, before the
 * driver has read anything. It now takes that red from the theme's error
 * container rather than a hard-coded 0xFF7F1D1D, so it is the same red the
 * dispatcher sees on a failed action.
 */
@Composable
private fun CrashBanner(report: String, onShare: () -> Unit, onDismiss: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.Error,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    stringResource(R.string.crash_prompt),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            Surface(
                color = MaterialTheme.colorScheme.scrim.copy(alpha = 0.16f),
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.padding(top = 10.dp),
            ) {
                Text(
                    report.lineSequence().take(if (expanded) 40 else 6).joinToString("\n"),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .padding(10.dp)
                        .heightIn(max = if (expanded) 320.dp else 96.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
            Row {
                TextButton(onClick = { expanded = !expanded }) {
                    Text(
                        stringResource(if (expanded) R.string.crash_collapse else R.string.crash_show_all),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
                TextButton(onClick = onShare) {
                    Text(
                        stringResource(R.string.crash_send_short),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
                TextButton(onClick = onDismiss) {
                    Text(
                        stringResource(R.string.diag_clear),
                        color = MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.72f),
                    )
                }
            }
        }
    }
}

/** Send the driver to the app's system settings page. */
private fun openAppSettings(context: Context) {
    context.startActivity(
        Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}

/**
 * Unwrap the Activity from whatever Context Compose hands us.
 *
 * A bare `LocalContext.current as Activity` is a latent ClassCastException:
 * Hilt, theme overlays and several libraries wrap the Activity in a
 * ContextWrapper, and the cast then kills the screen. Only
 * shouldShowRequestPermissionRationale needs the Activity, so failing soft is
 * correct — the Settings fallback still works without it.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun ReadinessScreen(state: TrackerUiState, viewModel: TrackerViewModel) {
    val context = LocalContext.current
    val activity = context.findActivity()

    // Once the platform marks a permission permanently denied, launch() returns
    // DENIED synchronously with no UI, refreshChecks() repaints the same red
    // row, and the "Aç" button is a no-op forever. Since background location is
    // now blocking, that would strand the driver with a button they cannot
    // satisfy. Track whether we have already asked so we can fall back to
    // Settings, which is the only surface carrying "Her zaman izin ver".
    var bgAsked by rememberSaveable { mutableStateOf(false) }
    var notifAsked by rememberSaveable { mutableStateOf(false) }

    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { viewModel.refreshChecks() }

    // Play Services' "turn on location?" dialog is delivered as an IntentSender,
    // not an Intent, so it needs its own contract. Launching e.resolution
    // directly from the Context would show the dialog and then throw the answer
    // away — the row would stay red until the 2-second poll caught up.
    val locationSettingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult(),
    ) { viewModel.refreshChecks() }

    val locationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { viewModel.refreshChecks() }

    val backgroundLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { viewModel.refreshChecks() }

    Box(Modifier.fillMaxSize()) {
        BrandWash()

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp, vertical = 22.dp),
        ) {
            Text(
                stringResource(R.string.readiness_ready),
                style = MaterialTheme.typography.headlineSmall,
            )
            state.reference?.let {
                Spacer(Modifier.height(10.dp))
                ReferenceChip(it)
            }

            Spacer(Modifier.height(20.dp))
            Section {
                state.orderNumber?.let { InfoRow(stringResource(R.string.label_order), it) }
                state.customerName?.let { InfoRow(stringResource(R.string.label_customer), it) }
                state.destination?.let { InfoRow(stringResource(R.string.label_destination), it) }
            }

            Spacer(Modifier.height(26.dp))
            Text(
                stringResource(R.string.readiness_heading),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.readiness_warning),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))

            /*
             * One card with dividers, not eight separate cards.
             *
             * Eight stacked cards is eight shadows, eight borders and eight gaps
             * for a list whose entire job is to be read top to bottom until the
             * first red row. Grouping them is what makes "how far down the list
             * am I" answerable at a glance, and it is the same shape the
             * dispatcher's screens use for a run of related rows.
             */
            Section(padded = false) {
                state.checks.forEachIndexed { index, check ->
                    if (index > 0) {
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                    CheckRow(
                        label = check.label,
                        detail = check.detail,
                        satisfied = check.satisfied,
                        blocking = check.blocking,
                        onFix = {
                            when (check.key) {
                                // Try to fix it without leaving the app. Play Services
                                // shows a system dialog over us and one tap turns
                                // location on; only when that is unavailable — Huawei,
                                // de-Googled phones — do we hand the driver off to the
                                // Settings screen and hope they find the switch.
                                "location_services" -> LocationSettingsHelper.requestEnable(
                                    context = context,
                                    onResolution = { resolvable ->
                                        runCatching {
                                            locationSettingsLauncher.launch(
                                                IntentSenderRequest.Builder(resolvable.resolution).build(),
                                            )
                                        }.onFailure { LocationSettingsHelper.openSettings(context) }
                                    },
                                    onUnavailable = { LocationSettingsHelper.openSettings(context) },
                                )

                                "location" -> locationLauncher.launch(
                                    arrayOf(
                                        Manifest.permission.ACCESS_FINE_LOCATION,
                                        Manifest.permission.ACCESS_COARSE_LOCATION,
                                    ),
                                )

                                // Must be a SEPARATE request after foreground is granted —
                                // Android 11+ rejects a combined foreground+background ask.
                                "background_location" -> when {
                                    Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> Unit

                                    // The platform refuses the background dialog until
                                    // foreground is held. Route to the ask that can
                                    // actually succeed instead of showing nothing.
                                    !state.checks.any { it.key == "location" && it.satisfied } ->
                                        locationLauncher.launch(
                                            arrayOf(
                                                Manifest.permission.ACCESS_FINE_LOCATION,
                                                Manifest.permission.ACCESS_COARSE_LOCATION,
                                            ),
                                        )

                                    // shouldShowRationale == false *after* a denial is
                                    // the documented "permanently denied" signal.
                                    bgAsked && activity != null &&
                                        !ActivityCompat.shouldShowRequestPermissionRationale(
                                            activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION,
                                        ) -> openAppSettings(context)

                                    else -> {
                                        bgAsked = true
                                        backgroundLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                                    }
                                }

                                "notifications" -> when {
                                    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> Unit
                                    notifAsked && activity != null &&
                                        !ActivityCompat.shouldShowRequestPermissionRationale(
                                            activity, Manifest.permission.POST_NOTIFICATIONS,
                                        ) -> openAppSettings(context)
                                    else -> {
                                        notifAsked = true
                                        notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                }

                                // No runtime prompt exists for this; the phone either
                                // has a working Play Services or it does not.
                                "play_services" -> openAppSettings(context)

                                "battery" -> PowerHelper.requestIgnoreBatteryOptimizations(context)
                                "exact_alarm" -> PowerHelper.requestExactAlarmPermission(context)
                                "autostart" -> PowerHelper.openAutostartSettings(context)
                            }
                        },
                    )
                }
            }

            Spacer(Modifier.height(26.dp))
            Button(
                onClick = { viewModel.startTracking(context) },
                enabled = state.canStart,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
            ) {
                Text(
                    stringResource(R.string.readiness_start),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(6.dp))
            TextButton(
                onClick = { viewModel.endSession(context) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    stringResource(R.string.tracking_close_session),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun TrackingScreen(state: TrackerUiState, viewModel: TrackerViewModel) {
    val context = LocalContext.current
    val time = remember { SimpleDateFormat("HH:mm:ss", Locale.getDefault()) }

    val locationSettingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult(),
    ) { viewModel.refreshChecks() }

    Box(Modifier.fillMaxSize()) {
        BrandWash()

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp, vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            /*
             * The checklist gate is not enough for this one row.
             *
             * Location is the only requirement a driver can revoke *after*
             * starting — two taps in the notification shade, often by accident
             * while reaching for the torch. Everything downstream keeps claiming
             * success: the service runs, the notification says "Takip aktif",
             * the screen above says "Konumunuz merkeze gönderiliyor". The only
             * visible symptom is that "Son konum" stops advancing, which nobody
             * watches.
             *
             * So it is checked again here, on the screen the driver actually
             * looks at, with the same one-tap fix.
             */
            if (!state.locationServicesOn) {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Default.Error,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.size(20.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                stringResource(R.string.location_off_title),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                        Text(
                            stringResource(R.string.location_off_body),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        Button(
                            onClick = {
                                LocationSettingsHelper.requestEnable(
                                    context = context,
                                    onResolution = { resolvable ->
                                        runCatching {
                                            locationSettingsLauncher.launch(
                                                IntentSenderRequest.Builder(resolvable.resolution).build(),
                                            )
                                        }.onFailure { LocationSettingsHelper.openSettings(context) }
                                    },
                                    onUnavailable = { LocationSettingsHelper.openSettings(context) },
                                )
                            },
                            shape = MaterialTheme.shapes.small,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 10.dp),
                        ) { Text(stringResource(R.string.location_off_action), fontWeight = FontWeight.Bold) }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }

            // A background failure — an unreadable buffer, a store that will not
            // open — used to be written to state.error and then rendered nowhere on
            // this screen, which is where a driver spends the entire shift.
            state.error?.let {
                Notice(tone = NoticeTone.DANGER, text = it)
                Spacer(Modifier.height(12.dp))
            }

            Spacer(Modifier.height(18.dp))

            /*
             * The status, in a tinted well rather than as a loose glyph.
             *
             * It was a bare 72dp icon floating on the background. A circle of
             * the state's own colour behind it does two things a lone icon
             * cannot: it survives being glanced at from a cradle at arm's
             * length, and it carries the state in an area rather than in a
             * shape — which is what a driver sees first in bright cab light.
             */
            val online = state.online
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .clip(CircleShape)
                    .background(
                        if (online) MaterialTheme.status.liveContainer
                        else MaterialTheme.status.warnContainer,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (online) Icons.Default.CheckCircle else Icons.Default.CloudOff,
                    contentDescription = null,
                    tint = if (online) MaterialTheme.status.live else MaterialTheme.status.warn,
                    modifier = Modifier.size(44.dp),
                )
            }
            Spacer(Modifier.height(18.dp))
            Text(
                stringResource(if (online) R.string.tracking_active else R.string.tracking_offline),
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                // The single most important sentence in the app: it stops a driver
                // in a dead zone from concluding it is broken and force-stopping it.
                if (online) {
                    stringResource(R.string.tracking_online_body)
                } else {
                    stringResource(R.string.tracking_offline_body)
                },
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            RemainingDistance(state)

            Spacer(Modifier.height(26.dp))

            Section {
                state.reference?.let { InfoRow(stringResource(R.string.label_session), it) }
                state.orderNumber?.let { InfoRow(stringResource(R.string.label_order), it) }
                state.destination?.let { InfoRow(stringResource(R.string.label_destination), it) }
                HorizontalDivider(
                    color = MaterialTheme.colorScheme.outlineVariant,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                InfoRow(stringResource(R.string.label_pending), state.pendingCount.toString())
                InfoRow(
                    stringResource(R.string.label_last_fix),
                    if (state.lastFixAt > 0) time.format(Date(state.lastFixAt)) else "—",
                )
                InfoRow(
                    stringResource(R.string.label_last_sync),
                    if (state.lastSyncAt > 0) time.format(Date(state.lastSyncAt)) else "—",
                )
            }

            if (state.pendingCount > 50) {
                Spacer(Modifier.height(12.dp))
                Notice(
                    tone = NoticeTone.WARN,
                    text = stringResource(R.string.tracking_pending_note, state.pendingCount.toString()),
                )
            }

            Spacer(Modifier.height(26.dp))
            OutlinedButton(
                onClick = { viewModel.syncNow(context) },
                shape = MaterialTheme.shapes.small,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
            ) { Text(stringResource(R.string.tracking_sync_now)) }

            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { viewModel.stopTracking(context) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
                shape = MaterialTheme.shapes.small,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
            ) { Text(stringResource(R.string.tracking_stop), fontWeight = FontWeight.Bold) }

            Spacer(Modifier.height(22.dp))
            Text(
                stringResource(R.string.tracking_background_note),
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

// =============================================================================
// Bits
// =============================================================================

/**
 * The monogram, at whatever size the caller needs.
 *
 * The same mark the dispatcher's navigation dock carries and the same one at
 * the top of all three web pages. A driver never sees the dashboard, so this is
 * not continuity for them — it is continuity for the dispatcher standing beside
 * them at the loading dock, and for the printed sheet the code was scanned off.
 */
@Composable
private fun BrandMark(size: Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.28f))
            .background(MaterialTheme.status.brandGradient),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "KH",
            color = MaterialTheme.colorScheme.onPrimary,
            fontWeight = FontWeight.ExtraBold,
            fontSize = (size.value * 0.33f).sp,
            letterSpacing = (-0.4).sp,
        )
    }
}

/**
 * One wash of the brand colour down from the top of the screen.
 *
 * Very low opacity and very tall, so it reads as light in the room rather than
 * as a shape on the page. It is the cheapest thing that stops a flat background
 * from looking unstyled, and it is the same device the login screen and all
 * three web pages use.
 */
@Composable
private fun BrandWash() {
    val tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.09f)
    Box(
        Modifier
            .fillMaxWidth()
            .height(300.dp)
            .background(Brush.verticalGradient(listOf(tint, Color.Transparent))),
    )
}

/**
 * A raised group of rows.
 *
 * `padded = false` for a list whose own rows carry the padding — a run of check
 * rows separated by full-bleed dividers, where an outer inset would leave every
 * divider stopping short of both edges.
 */
@Composable
private fun Section(
    padded: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = 1.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(if (padded) Modifier.padding(16.dp) else Modifier, content = content)
    }
}

/** The session reference, as a chip rather than a line of coloured text. */
@Composable
private fun ReferenceChip(reference: String) {
    Surface(
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        shape = MaterialTheme.shapes.extraSmall,
    ) {
        Text(
            reference,
            style = MaterialTheme.typography.labelLarge,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
}

private enum class NoticeTone { DANGER, WARN }

/**
 * A tinted line of explanation — an error, or a backlog worth mentioning.
 *
 * Colour is never the only encoding: every tone carries its own icon as well,
 * because roughly one man in twelve cannot separate the red from the amber and
 * this app is read at a glance in a moving vehicle.
 */
@Composable
private fun Notice(tone: NoticeTone, text: String) {
    val fg = when (tone) {
        NoticeTone.DANGER -> MaterialTheme.status.danger
        NoticeTone.WARN -> MaterialTheme.status.warn
    }
    val bg = when (tone) {
        NoticeTone.DANGER -> MaterialTheme.status.dangerContainer
        NoticeTone.WARN -> MaterialTheme.status.warnContainer
    }
    Surface(color = bg, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Error, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(9.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, color = fg)
        }
    }
}

/**
 * How far is left, and whether we are there.
 *
 * The server has sent this coordinate to the phone since the first version of
 * the claim response and the app never looked at it, so a driver eighteen hours
 * into a run to Erbil had no idea how much was left and nothing ever told them
 * they had arrived. If they forgot to stop, the session ran on — flattening
 * their battery and showing the dispatcher a shipment that looked live long
 * after it was delivered.
 *
 * Placed above the fact card rather than inside it because it is the only thing
 * on this screen that changes as the lorry moves, and putting it in a list of
 * static identifiers would bury it. Absent entirely when the order has no
 * destination, which is three orders in four — a screen that says nothing is
 * better than one showing a number it cannot stand behind.
 */
@Composable
private fun RemainingDistance(state: TrackerUiState) {
    if (state.arrived) {
        Spacer(Modifier.height(20.dp))
        Surface(
            color = MaterialTheme.status.liveContainer,
            contentColor = MaterialTheme.status.live,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                Modifier.padding(vertical = 14.dp, horizontal = 16.dp).fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    stringResource(R.string.arrival_banner),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                )
            }
        }
        return
    }

    val metres = state.remainingM ?: return
    val (value, unit) = formatRemaining(metres)
    Spacer(Modifier.height(20.dp))
    Text(
        when (unit) {
            DistanceUnit.METRES -> stringResource(R.string.distance_metres, value)
            DistanceUnit.KILOMETRES -> stringResource(R.string.distance_kilometres, value)
        },
        // Deliberately the largest text on the screen after the status line.
        // A driver glancing at a phone in a cradle reads exactly one thing.
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * Language, in the languages themselves.
 *
 * On the claim screen because that is the first thing a driver sees and the
 * moment the choice matters — after this screen they are reading a running
 * shipment, not deciding anything.
 *
 * Every label is written in its own language. A picker offering "Arapça" is no
 * use to somebody who cannot read Turkish, which is precisely who it is for.
 *
 * Changing it recreates the activity, which is what re-resolves a Compose tree
 * whose strings have already been read. The tracking notification needs no
 * restart — the service resolves its strings at post time.
 */
@Composable
private fun LanguagePicker() {
    val context = LocalContext.current
    var selected by remember { mutableStateOf(AppLocale.current(context)) }

    /*
     * "Let the phone decide" first, then the three languages.
     *
     * It is the only entry here that is a sentence rather than a name, so it is
     * the only one that has to be translated — an Arabic-reading driver was
     * being shown three names they could read and one Turkish phrase they could
     * not, in the same row.
     */
    val labels: List<Pair<String, String>> =
        listOf(AppLocale.SYSTEM to stringResource(R.string.language_system)) + AppLocale.options

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        labels.forEach { (tag, label) ->
            val active = tag == selected
            FilterChip(
                selected = active,
                onClick = {
                    if (active) return@FilterChip
                    selected = tag
                    AppLocale.set(context, tag)
                    // On API 33+ the platform recreates us itself once the
                    // LocaleManager write lands; below that nothing does.
                    // Calling it either way is harmless and covers both.
                    (context as? Activity)?.recreate()
                },
                shape = MaterialTheme.shapes.extraSmall,
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = MaterialTheme.colorScheme.primary,
                    selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
                ),
                border = FilterChipDefaults.filterChipBorder(
                    enabled = true,
                    selected = active,
                    borderColor = MaterialTheme.colorScheme.outlineVariant,
                    selectedBorderColor = MaterialTheme.colorScheme.primary,
                ),
                label = { Text(label, style = MaterialTheme.typography.labelMedium) },
            )
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(16.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun CheckRow(
    label: String,
    detail: String,
    satisfied: Boolean,
    blocking: Boolean,
    onFix: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tint = when {
            satisfied -> MaterialTheme.status.live
            blocking -> MaterialTheme.status.danger
            else -> MaterialTheme.status.warn
        }
        /*
         * The icon in its own tinted disc.
         *
         * A 22dp glyph on a white row is the smallest thing on the screen and
         * carries the one fact the row exists to state. The disc gives it an
         * area, which is what makes a red row findable while scrolling past
         * eight of them.
         */
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(CircleShape)
                .background(tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (satisfied) Icons.Default.CheckCircle else Icons.Default.Error,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (!satisfied) {
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onFix) { Text(stringResource(R.string.action_open)) }
        }
    }
}
