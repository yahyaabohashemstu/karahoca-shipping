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

@Composable
private fun ClaimScreen(state: TrackerUiState, viewModel: TrackerViewModel) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(48.dp))
        Text(
            "KARAHOCA",
            style = MaterialTheme.typography.labelLarge,
            letterSpacing = 4.sp,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.claim_heading), style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(40.dp))

        LanguagePicker()
        Spacer(Modifier.height(24.dp))

        Text(
            stringResource(R.string.claim_hint),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))

        OutlinedTextField(
            value = state.codeInput,
            onValueChange = viewModel::onCodeChanged,
            label = { Text(stringResource(R.string.claim_field_label)) },
            placeholder = { Text("K7H2-9QX4") },
            singleLine = true,
            isError = state.error != null,
            textStyle = TextStyle(
                fontSize = 28.sp,
                fontFamily = FontFamily.Monospace,
                // 6sp of tracking pushed a formatted 9-character code past the
                // field on a 5" phone, and the dash is the character that goes
                // missing first. Enough to keep the groups legible, not enough
                // to overflow.
                letterSpacing = 3.sp,
                textAlign = TextAlign.Center,
            ),
            // The dash appears by itself after the fourth character. It is
            // painted, not typed: what the state holds stays 8 clean
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
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = viewModel::claim,
            enabled = !state.busy && state.canClaim,
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) {
            if (state.busy) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Text(stringResource(R.string.claim_submit), fontSize = 16.sp)
            }
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
 */
@Composable
private fun CrashBanner(report: String, onShare: () -> Unit, onDismiss: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Surface(color = Color(0xFF7F1D1D)) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Text(
                stringResource(R.string.crash_prompt),
                color = Color.White,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                report.lineSequence().take(if (expanded) 40 else 6).joinToString("\n"),
                color = Color(0xFFFECACA),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .padding(top = 6.dp)
                    .heightIn(max = if (expanded) 320.dp else 96.dp)
                    .verticalScroll(rememberScrollState()),
            )
            Row {
                TextButton(onClick = { expanded = !expanded }) {
                    Text(stringResource(if (expanded) R.string.crash_collapse else R.string.crash_show_all), color = Color.White)
                }
                TextButton(onClick = onShare) { Text(stringResource(R.string.crash_send_short), color = Color.White) }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.diag_clear), color = Color(0xFFFCA5A5)) }
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(stringResource(R.string.readiness_ready), style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(4.dp))
        state.reference?.let {
            Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        }
        Spacer(Modifier.height(16.dp))

        ElevatedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                state.orderNumber?.let { InfoRow(stringResource(R.string.label_order), it) }
                state.customerName?.let { InfoRow(stringResource(R.string.label_customer), it) }
                state.destination?.let { InfoRow(stringResource(R.string.label_destination), it) }
            }
        }

        Spacer(Modifier.height(24.dp))
        Text(stringResource(R.string.readiness_heading), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            stringResource(R.string.readiness_warning),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        state.checks.forEach { check ->
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
            Spacer(Modifier.height(8.dp))
        }

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { viewModel.startTracking(context) },
            enabled = state.canStart,
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) {
            Text(stringResource(R.string.readiness_start), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(8.dp))
        TextButton(
            onClick = { viewModel.endSession(context) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.tracking_close_session))
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun TrackingScreen(state: TrackerUiState, viewModel: TrackerViewModel) {
    val context = LocalContext.current
    val time = remember { SimpleDateFormat("HH:mm:ss", Locale.getDefault()) }

    val locationSettingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult(),
    ) { viewModel.refreshChecks() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        /*
         * The checklist gate is not enough for this one row.
         *
         * Location is the only requirement a driver can revoke *after* starting
         * — two taps in the notification shade, often by accident while
         * reaching for the torch. Everything downstream keeps claiming success:
         * the service runs, the notification says "Takip aktif", the screen
         * above says "Konumunuz merkeze gönderiliyor". The only visible symptom
         * is that "Son konum" stops advancing, which nobody watches.
         *
         * So it is checked again here, on the screen the driver actually looks
         * at, with the same one-tap fix.
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
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                    ) { Text(stringResource(R.string.location_off_action), fontWeight = FontWeight.Bold) }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        // A background failure — an unreadable buffer, a store that will not
        // open — used to be written to state.error and then rendered nowhere on
        // this screen, which is where a driver spends the entire shift.
        state.error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            )
        }

        Spacer(Modifier.height(24.dp))

        Icon(
            imageVector = if (state.online) Icons.Default.CheckCircle else Icons.Default.CloudOff,
            contentDescription = null,
            tint = if (state.online) Color(0xFF16A34A) else Color(0xFFF59E0B),
            modifier = Modifier.size(72.dp),
        )
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(if (state.online) R.string.tracking_active else R.string.tracking_offline),
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            // The single most important sentence in the app: it stops a driver
            // in a dead zone from concluding it is broken and force-stopping it.
            if (state.online) {
                stringResource(R.string.tracking_online_body)
            } else {
                stringResource(R.string.tracking_offline_body)
            },
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        RemainingDistance(state)

        Spacer(Modifier.height(28.dp))

        ElevatedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                state.reference?.let { InfoRow(stringResource(R.string.label_session), it) }
                state.orderNumber?.let { InfoRow(stringResource(R.string.label_order), it) }
                state.destination?.let { InfoRow(stringResource(R.string.label_destination), it) }
                HorizontalDivider(Modifier.padding(vertical = 12.dp))
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
        }

        if (state.pendingCount > 50) {
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Error, null, tint = Color(0xFFF59E0B), modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    stringResource(R.string.tracking_pending_note, state.pendingCount.toString()),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Spacer(Modifier.height(28.dp))
        OutlinedButton(
            onClick = { viewModel.syncNow(context) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.tracking_sync_now)) }

        Spacer(Modifier.height(8.dp))
        Button(
            onClick = { viewModel.stopTracking(context) },
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) { Text(stringResource(R.string.tracking_stop), fontWeight = FontWeight.Bold) }

        Spacer(Modifier.height(24.dp))
        Text(
            stringResource(R.string.tracking_background_note),
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
    }
}

// =============================================================================
// Bits
// =============================================================================

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
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                stringResource(R.string.arrival_banner),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.padding(vertical = 14.dp),
            )
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

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AppLocale.options.forEach { (tag, label) ->
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
                label = { Text(label, style = MaterialTheme.typography.labelMedium) },
            )
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
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
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (satisfied) Icons.Default.CheckCircle else Icons.Default.Error,
                contentDescription = null,
                tint = when {
                    satisfied -> Color(0xFF16A34A)
                    blocking -> MaterialTheme.colorScheme.error
                    else -> Color(0xFFF59E0B)
                },
                modifier = Modifier.size(22.dp),
            )
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
                TextButton(onClick = onFix) { Text(stringResource(R.string.action_open)) }
            }
        }
    }
}
