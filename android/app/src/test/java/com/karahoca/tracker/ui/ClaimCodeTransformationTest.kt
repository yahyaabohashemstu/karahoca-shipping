package com.karahoca.tracker.ui

import androidx.compose.ui.text.AnnotatedString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A wrong OffsetMapping does not misalign the cursor — Compose validates every
 * index it is handed and throws IllegalArgumentException, which on the claim
 * screen means the app dies on a keystroke. So the interesting assertions here
 * are the range invariants, checked exhaustively over every reachable
 * (length, offset) pair rather than at a few hand-picked points.
 */
class ClaimCodeTransformationTest {

    private val transformation = ClaimCodeTransformation()

    private fun transform(value: String) = transformation.filter(AnnotatedString(value))

    @Test
    fun `dash appears only once the fifth character exists`() {
        assertEquals("", transform("").text.text)
        assertEquals("K7H2", transform("K7H2").text.text)
        assertEquals("K7H2-9", transform("K7H29").text.text)
        assertEquals("K7H2-9QX4", transform("K7H29QX4").text.text)
    }

    @Test
    fun `cursor at the end of a full code lands after the last character`() {
        val mapping = transform("K7H29QX4").offsetMapping
        assertEquals(9, mapping.originalToTransformed(8))
    }

    @Test
    fun `the character just typed stays under the cursor across the dash`() {
        // "K7H2" + "9": the 9 is original index 4, so the cursor sits at
        // original 5 — which must land after the 9, at transformed 6, not
        // between the dash and the 9.
        val mapping = transform("K7H29").offsetMapping
        assertEquals(6, mapping.originalToTransformed(5))
        // And the position immediately after the dash maps back onto the same
        // model index as the position before it: the dash is not in the model.
        assertEquals(4, mapping.transformedToOriginal(4))
        assertEquals(4, mapping.transformedToOriginal(5))
    }

    @Test
    fun `every offset both ways stays in range for every reachable length`() {
        for (length in 0..8) {
            val original = "K7H29QX4".take(length)
            val result = transform(original)
            val transformedLength = result.text.text.length
            val mapping = result.offsetMapping

            for (offset in 0..length) {
                val t = mapping.originalToTransformed(offset)
                assertTrue(
                    "originalToTransformed($offset) = $t out of 0..$transformedLength (len=$length)",
                    t in 0..transformedLength,
                )
            }
            for (offset in 0..transformedLength) {
                val o = mapping.transformedToOriginal(offset)
                assertTrue(
                    "transformedToOriginal($offset) = $o out of 0..$length (len=$length)",
                    o in 0..length,
                )
            }
        }
    }

    @Test
    fun `round trip through the transformed space is lossless`() {
        for (length in 0..8) {
            val original = "K7H29QX4".take(length)
            val mapping = transform(original).offsetMapping
            for (offset in 0..length) {
                assertEquals(
                    "round trip failed at offset $offset of $length",
                    offset,
                    mapping.transformedToOriginal(mapping.originalToTransformed(offset)),
                )
            }
        }
    }

    /**
     * Compose can query a mapping built for the previous value while the new
     * one is still settling — a paste that shortens the field, or an IME
     * committing a composition. An unclamped `offset + 1` throws there.
     */
    @Test
    fun `out-of-range queries clamp instead of throwing`() {
        val mapping = transform("K7H29QX4").offsetMapping
        assertEquals(9, mapping.originalToTransformed(99))
        assertEquals(0, mapping.originalToTransformed(-3))
        assertEquals(8, mapping.transformedToOriginal(99))
        assertEquals(0, mapping.transformedToOriginal(-3))
    }
}
