package com.karahoca.tracker.util

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Hardware-backed envelope encryption for the two secrets on the device: the
 * driver access/refresh tokens and the per-session HMAC ingest key.
 *
 * Why bother, when the phone is company-issued and the token dies with the
 * session? Because these phones are handed to third-party drivers we do not
 * employ. A key sealed in the StrongBox/TEE cannot be lifted off a rooted
 * device or read out of an `adb backup`, so the worst case for a lost phone is
 * "revoke that one session" rather than "someone can forge our telemetry".
 */
object Keystore {

    private const val PROVIDER = "AndroidKeyStore"
    private const val KEY_ALIAS = "karahoca.tracker.secretbox.v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(PROVIDER).apply { load(null) }
    }

    private fun secretKey(): SecretKey {
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Explicitly NOT setUserAuthenticationRequired: the foreground
                // service must be able to decrypt the ingest key at 04:00 while
                // the phone is locked in the driver's pocket.
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    /** Returns base64( iv ‖ ciphertext ‖ tag ). */
    fun seal(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val out = ByteArray(cipher.iv.size + ct.size)
        cipher.iv.copyInto(out, 0)
        ct.copyInto(out, cipher.iv.size)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /**
     * Returns null rather than throwing when the blob cannot be opened — the
     * key is invalidated by a factory reset or a lock-screen change, and the
     * correct response is "re-claim the session", not "crash the tracker".
     */
    fun open(sealed: String?): String? {
        if (sealed.isNullOrEmpty()) return null
        return runCatching {
            val raw = Base64.decode(sealed, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES),
            )
            String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
        }.getOrNull()
    }
}
