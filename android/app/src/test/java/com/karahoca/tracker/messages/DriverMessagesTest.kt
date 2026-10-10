package com.karahoca.tracker.messages

import com.karahoca.tracker.data.remote.DriverMessageDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bookkeeping between the server's copy of a thread and the phone's.
 *
 * Every rule here exists to keep one of two promises to the people at either
 * end: the driver is told about each message exactly once, and the dispatcher's
 * ticks are never wrong in the flattering direction — a message is not shown
 * as read because a request was lost, and a read is not lost because the phone
 * was in a tunnel when the button was pressed.
 */
class DriverMessagesTest {

    private fun dto(id: String, at: String, readAt: String? = null) =
        DriverMessageDto(id = id, body = "body $id", sentAt = at, readAt = readAt)

    @Test
    fun `a new message is announced once and owes a delivery receipt`() {
        val merged = mergeMessages(emptyList(), listOf(dto("a", "2026-10-10T08:00:00Z")))

        assertEquals(listOf("a"), toAnnounce(merged).map { it.id })
        assertEquals(listOf("a"), owedReceipts(merged).delivered)
        assertTrue(owedReceipts(merged).read.isEmpty())

        // Announced and receipted, it is never announced again however often
        // the server repeats it.
        val settled = settle(merged.map { it.copy(notified = true) }, owedReceipts(merged))
        val again = mergeMessages(settled, listOf(dto("a", "2026-10-10T08:00:00Z")))
        assertTrue(toAnnounce(again).isEmpty())
        assertTrue(owedReceipts(again).isEmpty)
    }

    @Test
    fun `a message already read elsewhere is neither announced nor receipted`() {
        val merged = mergeMessages(
            emptyList(),
            listOf(dto("a", "2026-10-10T08:00:00Z", readAt = "2026-10-10T08:05:00Z")),
        )
        assertTrue(merged.single().read)
        assertTrue(toAnnounce(merged).isEmpty())
        assertTrue(owedReceipts(merged).isEmpty)
    }

    @Test
    fun `the server cannot un-read a message the phone has not reported yet`() {
        val local = listOf(
            StoredMessage("a", "x", 1L, read = true, readAt = 5L, notified = true, deliveryAcked = true),
        )
        val merged = mergeMessages(local, listOf(dto("a", "2026-10-10T08:00:00Z")))

        assertTrue(merged.single().read)
        assertEquals(5L, owedReceipts(merged).read.single().at)
    }

    @Test
    fun `a read receipt carries the delivery, so the delivery is not sent twice`() {
        val local = listOf(StoredMessage("a", "x", 1L, read = true, readAt = 9L, notified = true))
        val owed = owedReceipts(local)

        assertTrue(owed.delivered.isEmpty())
        assertEquals(listOf("a"), owed.read.map { it.id })

        val settled = settle(local, owed).single()
        assertTrue(settled.deliveryAcked)
        assertTrue(settled.readAcked)
    }

    @Test
    fun `a read pressed while a receipt was in flight stays owed`() {
        val beforeRequest = listOf(StoredMessage("a", "x", 1L, notified = true))
        val owed = owedReceipts(beforeRequest)
        // The driver presses "read" while the delivery receipt is on the wire.
        val now = listOf(StoredMessage("a", "x", 1L, read = true, readAt = 3L, notified = true))

        val after = settle(now, owed).single()
        assertTrue(after.deliveryAcked)
        assertFalse("the read must still be reported", after.readAcked)
        assertEquals(listOf("a"), owedReceipts(listOf(after)).read.map { it.id })
    }

    @Test
    fun `announced in the order they were written, kept newest first`() {
        val merged = mergeMessages(
            emptyList(),
            listOf(
                dto("late", "2026-10-10T09:00:00Z"),
                dto("early", "2026-10-10T08:00:00Z"),
            ),
        )
        assertEquals(listOf("late", "early"), merged.map { it.id })
        assertEquals(listOf("early", "late"), toAnnounce(merged).map { it.id })
    }

    @Test
    fun `the phone keeps at most fifty`() {
        val remote = (0 until 70).map { i ->
            dto("m$i", java.time.Instant.ofEpochSecond(1_791_600_000L + i * 60L).toString())
        }
        val merged = mergeMessages(emptyList(), remote)
        assertEquals(MAX_KEPT, merged.size)
        assertEquals("the newest survive", "m69", merged.first().id)
    }

    @Test
    fun `both timestamp shapes are read, and nonsense is not`() {
        assertEquals(1_791_662_400_000L, parseInstant("2026-10-10T20:00:00Z"))
        assertEquals(1_791_662_400_000L, parseInstant("2026-10-10T23:00:00+03:00"))
        assertEquals(1_791_662_400_123L, parseInstant("2026-10-10T20:00:00.123Z"))
        assertNull(parseInstant("yesterday"))
    }
}
