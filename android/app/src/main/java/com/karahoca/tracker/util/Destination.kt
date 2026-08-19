package com.karahoca.tracker.util

import java.util.Locale
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Where the load is going, and how far is left.
 *
 * The server has been sending `destinationLat` and `destinationLon` to the
 * phone since the first version of the claim response, and the app has never
 * once looked at them — `SessionStore` kept the destination's *name* and threw
 * the coordinates away. So a driver eighteen hours into a run to Erbil had no
 * idea how far was left, and nothing ever told them they had arrived and could
 * stop. If they forgot, the session ran on, flattening their battery and
 * leaving a shipment that looks live to the dispatcher long after it was
 * delivered.
 *
 * Pure and free of Android, so the arithmetic that decides "you have arrived"
 * can be tested rather than trusted. That matters more than it sounds: the
 * threshold is the same one `kh.alerts` uses server-side, and the two must not
 * disagree about the same moment.
 */
data class Destination(
    val lat: Double,
    val lon: Double,
    /** Metres. The server's own arrival radius, so both sides agree. */
    val radiusM: Int,
    val label: String?,
) {

    /** Straight-line metres from a fix to here. */
    fun distanceFrom(lat: Double, lon: Double): Double = haversineMetres(lat, lon, this.lat, this.lon)

    /**
     * Whether a fix counts as arrival.
     *
     * Deliberately generous about accuracy: a fix with 400 m of uncertainty
     * inside a 300 m radius is not proof of arrival, but neither is it proof of
     * absence, and a lorry that has genuinely parked at the gate should not be
     * denied the prompt because the yard is roofed. So the accuracy is added to
     * the distance rather than to the radius — the vehicle must be inside the
     * circle even in the worst case the fix admits.
     */
    fun hasArrived(lat: Double, lon: Double, accuracyM: Float?): Boolean {
        val slack = (accuracyM ?: 0f).toDouble().coerceAtLeast(0.0)
        return distanceFrom(lat, lon) + slack <= radiusM
    }

    companion object {
        /**
         * Build one, or null if the order has no destination.
         *
         * Three orders in four in production have none, so null is the ordinary
         * case and every caller has to cope with it — the screen simply says
         * nothing about distance rather than showing a wrong number.
         */
        fun of(lat: Double?, lon: Double?, radiusM: Int?, label: String?): Destination? {
            if (lat == null || lon == null) return null
            if (lat !in -90.0..90.0 || lon !in -180.0..180.0) return null
            return Destination(
                lat = lat,
                lon = lon,
                // Matches ck_orders_radius. A null radius means the order was
                // created before the column had a value, and 300 m is the
                // column's own default.
                radiusM = (radiusM ?: DEFAULT_RADIUS_M).coerceIn(MIN_RADIUS_M, MAX_RADIUS_M),
                label = label,
            )
        }

        const val DEFAULT_RADIUS_M = 300
        const val MIN_RADIUS_M = 25
        const val MAX_RADIUS_M = 20_000
    }
}

/** Mean Earth radius, metres. */
private const val EARTH_RADIUS_M = 6_371_008.8

/**
 * Great-circle distance, by the haversine formula.
 *
 * Haversine rather than the law of cosines because the latter loses precision
 * on short distances — and short is exactly where this matters, since the
 * arrival decision is made within a few hundred metres of the gate. The
 * `min(1.0, …)` guards the arcsine against a value fractionally above 1 from
 * floating-point rounding when the two points are the same, which is not
 * hypothetical: a parked lorry reports the identical coordinate for hours.
 */
internal fun haversineMetres(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
    val phi1 = Math.toRadians(lat1)
    val phi2 = Math.toRadians(lat2)
    val dPhi = Math.toRadians(lat2 - lat1)
    val dLambda = Math.toRadians(lon2 - lon1)

    val a = sin(dPhi / 2) * sin(dPhi / 2) +
        cos(phi1) * cos(phi2) * sin(dLambda / 2) * sin(dLambda / 2)
    return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
}

/**
 * A distance a driver can read at a glance, in Turkish-agnostic digits.
 *
 * Under a kilometre it is metres rounded to fifty, because "847 m" implies a
 * precision a straight-line distance between two GPS fixes does not have and
 * invites a driver to look for a gate that is not there. Above ten kilometres
 * the decimal is dropped for the same reason.
 *
 * Returns the number and unit separately so the caller can place them in
 * whatever order its language wants — Arabic and Kurdish do not agree with
 * Turkish here.
 */
fun formatRemaining(metres: Double): Pair<String, DistanceUnit> = when {
    metres < 1_000 -> {
        val rounded = (metres / 50).toInt() * 50
        rounded.coerceAtLeast(0).toString() to DistanceUnit.METRES
    }
    /*
     * Locale.ROOT, and the unit test is what found this.
     *
     * String.format without an explicit locale follows the device's, and on a
     * phone set to Arabic that yields ٨٫٣ — Arabic-Indic digits with an Arabic
     * decimal separator — sitting beside a Latin plate number and a Latin
     * distance unit. The test asserted "8.3" and got "٨٫٣", which is exactly
     * what a driver in Erbil with an Arabic phone would have seen once the
     * Arabic translation shipped.
     *
     * Latin digits throughout, for the same reason the consignee's page pins
     * them: this screen is mostly identifiers and quantities, and half of them
     * come from data that will never be transliterated.
     */
    metres < 10_000 ->
        String.format(Locale.ROOT, "%.1f", metres / 1000.0) to DistanceUnit.KILOMETRES
    else -> (metres / 1000.0).toInt().toString() to DistanceUnit.KILOMETRES
}

enum class DistanceUnit { METRES, KILOMETRES }
