package com.karahoca.tracker.update

/**
 * Where the update is, as far as the driver is concerned.
 *
 * Deliberately not modelled as a set of booleans on the UI state. The states
 * are mutually exclusive and the banner renders one of them; two booleans that
 * can both be true is how a "downloading" spinner ends up sitting next to an
 * "update" button.
 */
sealed interface UpdateState {

    /** Nothing to say — either up to date, or we have not looked yet. */
    data object Idle : UpdateState

    /** A newer build exists and the driver has not asked for it. */
    data class Available(val manifest: UpdateManifest) : UpdateState

    /** Percent is -1 when the server did not give us a length to divide by. */
    data class Downloading(val manifest: UpdateManifest, val percent: Int) : UpdateState

    /** Hashing what arrived, before handing it to the package installer. */
    data class Verifying(val manifest: UpdateManifest) : UpdateState

    /**
     * Handed over. The system's confirmation dialog is next, and after it the
     * process is replaced — so nothing after this state is ours to observe.
     */
    data class Installing(val manifest: UpdateManifest) : UpdateState

    /**
     * @param reason already localised; it is shown verbatim.
     * @param needsUnknownSources the failure is Android refusing to let the app
     *   install anything, which is a settings toggle rather than an error —
     *   the banner offers a button to it instead of a retry.
     */
    data class Failed(
        val manifest: UpdateManifest,
        val reason: String,
        val needsUnknownSources: Boolean = false,
    ) : UpdateState

    val manifestOrNull: UpdateManifest?
        get() = when (this) {
            is Idle -> null
            is Available -> manifest
            is Downloading -> manifest
            is Verifying -> manifest
            is Installing -> manifest
            is Failed -> manifest
        }
}
