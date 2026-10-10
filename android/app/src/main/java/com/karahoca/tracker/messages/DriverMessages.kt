package com.karahoca.tracker.messages

import com.karahoca.tracker.data.remote.DriverMessageDto
import com.karahoca.tracker.data.remote.ReadReceiptDto
import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.serialization.Serializable

/** One message from the desk, as the screen shows it. */
data class DriverMessage(
    val id: String,
    val body: String,
    /** Epoch millis, server time. */
    val sentAt: Long,
    /** The driver pressed "read" — here, on the notification, or on another phone. */
    val read: Boolean,
)

/**
 * The phone's copy of one message, with the bookkeeping that lets a receipt
 * survive the process dying between "the driver pressed read" and "the server
 * heard about it". On this app the process dies constantly.
 */
@Serializable
internal data class StoredMessage(
    val id: String,
    val body: String,
    val sentAt: Long,
    val read: Boolean = false,
    /** When the driver pressed the button, on the server-corrected clock. */
    val readAt: Long? = null,
    /** The notification has been posted once; never post it twice. */
    val notified: Boolean = false,
    /** The server knows this phone has it. */
    val deliveryAcked: Boolean = false,
    /** The server knows the driver read it. */
    val readAcked: Boolean = false,
)

/** Every message held for one session. A different session means a clean slate. */
@Serializable
internal data class StoredThread(
    val sessionId: String,
    val messages: List<StoredMessage> = emptyList(),
)

/** How many a phone keeps. The server hands back the same fifty. */
internal const val MAX_KEPT = 50

/**
 * Fold what the server sent into what the phone already knows.
 *
 * Local flags win for anything already known — the server cannot know about a
 * read that has not been sent yet, and must not be able to un-read it. The one
 * thing the server can add is a read the phone did not see happen: the session
 * was moved to another phone, or a receipt from this one landed but its
 * response did not. A message that arrives already read is never notified.
 */
internal fun mergeMessages(
    local: List<StoredMessage>,
    remote: List<DriverMessageDto>,
): List<StoredMessage> {
    val byId = LinkedHashMap<String, StoredMessage>()
    local.forEach { byId[it.id] = it }

    for (dto in remote) {
        val known = byId[dto.id]
        val readElsewhere = dto.readAt != null
        byId[dto.id] = when {
            known == null -> StoredMessage(
                id = dto.id,
                body = dto.body,
                sentAt = parseInstant(dto.sentAt) ?: 0L,
                read = readElsewhere,
                notified = readElsewhere,
                // A read on the server implies a delivery on the server.
                deliveryAcked = readElsewhere,
                readAcked = readElsewhere,
            )
            readElsewhere && !known.readAcked -> known.copy(
                read = true,
                notified = true,
                deliveryAcked = true,
                readAcked = true,
            )
            else -> known
        }
    }

    return byId.values.sortedByDescending { it.sentAt }.take(MAX_KEPT)
}

/** Unread, never announced: the ones that still owe the driver a notification. */
internal fun toAnnounce(messages: List<StoredMessage>): List<StoredMessage> =
    messages.filter { !it.read && !it.notified }.sortedBy { it.sentAt }

/** What the server has not been told yet. */
internal data class Receipts(val delivered: List<String>, val read: List<ReadReceiptDto>) {
    val isEmpty: Boolean get() = delivered.isEmpty() && read.isEmpty()
}

internal fun owedReceipts(messages: List<StoredMessage>): Receipts {
    val read = messages.filter { it.read && !it.readAcked }
    val readIds = read.mapTo(HashSet()) { it.id }
    return Receipts(
        // A read receipt carries the delivery with it, so it is not sent twice.
        delivered = messages.filter { !it.deliveryAcked && it.id !in readIds }.map { it.id },
        read = read.map { ReadReceiptDto(it.id, it.readAt) },
    )
}

/** The server confirmed these receipts. */
internal fun settle(messages: List<StoredMessage>, receipts: Receipts): List<StoredMessage> {
    val delivered = receipts.delivered.toHashSet()
    val read = receipts.read.mapTo(HashSet()) { it.id }
    return messages.map { m ->
        when (m.id) {
            in read -> m.copy(deliveryAcked = true, readAcked = true)
            in delivered -> m.copy(deliveryAcked = true)
            else -> m
        }
    }
}

internal fun StoredMessage.toUi() = DriverMessage(id = id, body = body, sentAt = sentAt, read = read)

/*
 * Node serialises a Date as "…Z", which Instant.parse reads. The offset form
 * is the fallback because Instant.parse only learned to accept "+03:00" in
 * JDK 12, and this has to run on a phone's Java 8 library.
 */
internal fun parseInstant(value: String): Long? =
    runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
