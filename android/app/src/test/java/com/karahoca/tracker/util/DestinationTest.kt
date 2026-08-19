package com.karahoca.tracker.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic behind "you have arrived".
 *
 * Worth testing rather than trusting, because the same threshold is applied
 * server-side by kh.alerts and the two must not disagree about the same moment
 * — a driver told they have arrived while the dispatcher's board still says
 * in transit is worse than neither saying anything.
 */
class DestinationTest {

    /** The real corridor: the plant at Gaziantep, the consignee at Erbil. */
    private val plantLat = 37.0662
    private val plantLon = 37.3825
    private val erbilLat = 36.1911744
    private val erbilLon = 44.0094145

    private val erbil = Destination.of(erbilLat, erbilLon, 300, "أربيل")!!

    // ---- distance ----------------------------------------------------------

    @Test
    fun `Gaziantep to Erbil is about 600 km in a straight line`() {
        val km = erbil.distanceFrom(plantLat, plantLon) / 1000.0
        // The road is ~830 km; the great-circle is ~595. A wide band, because
        // the point of this assertion is to catch a formula that is wrong by an
        // order of magnitude or has latitude and longitude swapped.
        assertTrue("got $km km", km in 560.0..630.0)
    }

    @Test
    fun `the same point is zero away`() {
        // A parked lorry reports the identical coordinate for hours, and the
        // arcsine must not be handed a value fractionally above 1.
        assertEquals(0.0, erbil.distanceFrom(erbilLat, erbilLon), 0.001)
    }

    @Test
    fun `a hundred metres north measures a hundred metres`() {
        // 0.0008993 degrees of latitude is ~100 m anywhere on Earth.
        val d = erbil.distanceFrom(erbilLat + 0.0008993, erbilLon)
        assertEquals(100.0, d, 2.0)
    }

    @Test
    fun `longitude is scaled by latitude`() {
        // A degree of longitude is shorter away from the equator. At Erbil's
        // latitude 0.001 degrees is ~90 m, not ~111 m; a formula that forgot
        // the cosine term would report the larger figure.
        val d = erbil.distanceFrom(erbilLat, erbilLon + 0.001)
        assertTrue("got $d m", d in 85.0..95.0)
    }

    // ---- arrival -----------------------------------------------------------

    @Test
    fun `inside the radius with a good fix is arrival`() {
        assertTrue(erbil.hasArrived(erbilLat, erbilLon, 8f))
    }

    @Test
    fun `outside the radius is not arrival`() {
        // ~450 m north of a 300 m radius.
        assertFalse(erbil.hasArrived(erbilLat + 0.004, erbilLon, 8f))
    }

    /**
     * Accuracy is added to the distance, not to the radius.
     *
     * A fix 250 m out with 400 m of uncertainty could be anywhere in a 650 m
     * circle, so it is not proof of arrival. Adding the slack to the radius
     * instead would announce arrival from half a kilometre away every time a
     * driver pulls into a roofed yard.
     */
    @Test
    fun `a vague fix does not announce arrival`() {
        assertFalse(erbil.hasArrived(erbilLat + 0.00225, erbilLon, 400f))
    }

    @Test
    fun `a vague fix well inside the radius still counts`() {
        // Dead on the gate with 50 m of uncertainty, inside 300 m.
        assertTrue(erbil.hasArrived(erbilLat, erbilLon, 50f))
    }

    @Test
    fun `a missing or negative accuracy is treated as none`() {
        assertTrue(erbil.hasArrived(erbilLat, erbilLon, null))
        assertTrue(erbil.hasArrived(erbilLat, erbilLon, -1f))
    }

    // ---- construction ------------------------------------------------------

    @Test
    fun `no coordinate means no destination`() {
        // Three orders in four in production are in this state, so it is the
        // ordinary case rather than an error.
        assertNull(Destination.of(null, null, 300, "x"))
        assertNull(Destination.of(36.0, null, 300, "x"))
        assertNull(Destination.of(null, 44.0, 300, "x"))
    }

    @Test
    fun `an impossible coordinate is refused rather than plotted`() {
        assertNull(Destination.of(91.0, 44.0, 300, "x"))
        assertNull(Destination.of(36.0, 181.0, 300, "x"))
    }

    @Test
    fun `a missing radius falls back to the column default`() {
        assertEquals(Destination.DEFAULT_RADIUS_M, Destination.of(36.0, 44.0, null, null)!!.radiusM)
    }

    @Test
    fun `a radius outside the column's bounds is clamped, not rejected`() {
        // ck_orders_radius is 25..20000. A value outside it cannot have come
        // from the database, but it can come from a hand-edited response, and
        // dropping the destination entirely would be a worse answer than
        // clamping.
        assertEquals(Destination.MIN_RADIUS_M, Destination.of(36.0, 44.0, 1, null)!!.radiusM)
        assertEquals(Destination.MAX_RADIUS_M, Destination.of(36.0, 44.0, 999_999, null)!!.radiusM)
        assertNotNull(Destination.of(36.0, 44.0, 500, null))
    }

    // ---- formatting --------------------------------------------------------

    @Test
    fun `metres are rounded to fifty below a kilometre`() {
        assertEquals("800" to DistanceUnit.METRES, formatRemaining(847.0))
        assertEquals("250" to DistanceUnit.METRES, formatRemaining(260.0))
        assertEquals("0" to DistanceUnit.METRES, formatRemaining(10.0))
    }

    @Test
    fun `one decimal between one and ten kilometres`() {
        assertEquals("8.3" to DistanceUnit.KILOMETRES, formatRemaining(8_340.0))
        assertEquals("1.0" to DistanceUnit.KILOMETRES, formatRemaining(1_000.0))
    }

    @Test
    fun `no decimal above ten kilometres`() {
        // "594.7 km" implies a precision a straight line between two GPS fixes
        // does not have.
        assertEquals("594" to DistanceUnit.KILOMETRES, formatRemaining(594_700.0))
        assertEquals("10" to DistanceUnit.KILOMETRES, formatRemaining(10_000.0))
    }

    @Test
    fun `a negative distance cannot be produced`() {
        assertEquals("0" to DistanceUnit.METRES, formatRemaining(-5.0))
    }
}
