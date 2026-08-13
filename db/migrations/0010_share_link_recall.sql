-- =============================================================================
-- 0010 — Let a dispatcher read a share link back
-- =============================================================================
--
-- kh.share_links stores only sha256(token), so the URL could be shown exactly
-- once, at mint time. Leave the page and it is gone forever; the only recovery
-- is minting another link, which leaves the agent holding two and the
-- dispatcher unsure which one they sent.
--
-- That rule was borrowed from kh.refresh_tokens, and on reflection it does not
-- transfer. A refresh token grants the entire dispatcher dashboard — every
-- customer, every order, every position. A share token grants ONE shipment's
-- current position, to a party who is already entitled to know it, and it
-- travels to them as plaintext in a WhatsApp message. It is not in the same
-- risk class, and hashing it was buying almost nothing at the cost of the
-- thing a dispatcher actually needs: getting the link back.
--
-- So: keep the hash as the lookup key — the public path still resolves by
-- hashing what it was given, and the unique index still enforces uniqueness —
-- and store the token *alongside* it, encrypted with the same AES-GCM key and
-- helper already used for driver ingest keys (crypto.util encryptSecret). A
-- database dump on its own therefore still yields no working links: it also
-- takes INGEST_KEY_SECRET, which lives in the environment and not in the
-- backup.
--
-- Nullable on purpose. Links minted before this migration have no ciphertext
-- and can never get one; the dashboard shows them as un-recallable rather than
-- pretending, and a dispatcher who needs one of those mints a fresh link.
-- =============================================================================

ALTER TABLE kh.share_links
  ADD COLUMN IF NOT EXISTS token_enc bytea;

COMMENT ON COLUMN kh.share_links.token_enc IS
  'AES-GCM ciphertext of the raw token, under INGEST_KEY_SECRET. Lets the '
  'dispatcher re-read a link they already sent. NULL for links minted before '
  '0010, which are recall-impossible by construction.';
