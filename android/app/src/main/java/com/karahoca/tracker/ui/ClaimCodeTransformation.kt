package com.karahoca.tracker.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import com.karahoca.tracker.util.ClaimCode

/**
 * Draws `K7H29QX4` as `K7H2-9QX4` without the dash ever entering the state.
 *
 * The alternative — inserting a literal '-' into the field's value in
 * onValueChange — is what most apps do and it is wrong here for three reasons:
 * backspacing over the dash fights the user, the value then has to be stripped
 * again before every comparison and every request, and the cursor jumps
 * whenever the inserted character shifts the text under it. Keeping the model
 * canonical (8 characters, no separator) and formatting only at paint time
 * removes all three.
 *
 * The price is [OffsetMapping], and it has to be exactly right: Compose
 * validates every mapping it is given and throws IllegalArgumentException the
 * moment one returns an out-of-range index — which on this screen would crash
 * the app on the first keystroke, before the driver has done anything.
 */
class ClaimCodeTransformation : VisualTransformation {

    override fun filter(text: AnnotatedString): TransformedText {
        val original = text.text
        val formatted = ClaimCode.pretty(original)
        // No dash was inserted (0–4 characters typed): identity mapping, and no
        // opportunity for an off-by-one.
        val mapping = if (formatted.length == original.length) {
            OffsetMapping.Identity
        } else {
            DashOffsetMapping(originalLength = original.length)
        }
        return TransformedText(AnnotatedString(formatted), mapping)
    }

    override fun equals(other: Any?): Boolean = other is ClaimCodeTransformation

    override fun hashCode(): Int = javaClass.hashCode()
}

/**
 * Index translation across a single separator inserted after [ClaimCode.GROUP].
 *
 * Only constructed when the dash is actually present, i.e. when
 * `originalLength > GROUP`, so the transformed length is always
 * `originalLength + 1`.
 *
 * Both directions clamp. Compose can ask about an offset from the *previous*
 * value during recomposition — a paste that shortens the text, or an IME
 * committing a composition — and an unclamped `offset + 1` would then exceed
 * the new string. That is the classic crash in hand-written offset mappings.
 */
private class DashOffsetMapping(private val originalLength: Int) : OffsetMapping {

    private val transformedLength = originalLength + 1

    override fun originalToTransformed(offset: Int): Int {
        val clamped = offset.coerceIn(0, originalLength)
        val shifted = if (clamped <= ClaimCode.GROUP) clamped else clamped + 1
        return shifted.coerceIn(0, transformedLength)
    }

    override fun transformedToOriginal(offset: Int): Int {
        val clamped = offset.coerceIn(0, transformedLength)
        // Offset GROUP+1 sits immediately after the dash and maps back to the
        // same original index as GROUP — the dash occupies no position in the
        // model.
        val shifted = if (clamped <= ClaimCode.GROUP) clamped else clamped - 1
        return shifted.coerceIn(0, originalLength)
    }
}
