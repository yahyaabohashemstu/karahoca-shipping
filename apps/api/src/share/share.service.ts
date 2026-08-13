import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../common/crypto.util';
import type { CreateShareLinkDto } from './dto';

/**
 * A token is 32 random bytes rendered base64url — 43 characters, 256 bits.
 *
 * The claim code can afford to be eight characters because a driver reads it
 * down a phone line and a wrong guess only ever finds a session that is about
 * to be handed over anyway. This is the opposite case: the token IS the
 * credential, it is the only thing standing between a stranger and a customer's
 * shipment positions, and nobody ever types it — it arrives in a WhatsApp
 * message. There is no reason to be short, so we are not.
 */
const TOKEN_BYTES = 32;

/**
 * Shape check before we touch Postgres.
 *
 * Every character a real token can contain, and nothing else. Someone walking
 * the path with a wordlist gets rejected here instead of costing a connection
 * from a 20-slot pool on a 2-vCPU box — which, per the rate limiter's own
 * header comment, is the actual threat to an unauthenticated endpoint. Guessing
 * the token itself is not a threat at 256 bits.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;

/** What the consignee's page is allowed to know. Deliberately not FLEET_COLUMNS. */
export interface ConsigneeView {
  linkId: string;
  showRoute: boolean;
  showDriver: boolean;
  status: string;
  signalState: string;
  orderNumber: string;
  orderStatus: string;
  customerName: string;
  destinationLabel: string | null;
  destinationLat: number | null;
  destinationLon: number | null;
  plannedDeliveryAt: Date | null;
  lat: number | null;
  lon: number | null;
  recordedAt: Date | null;
  remainingKm: number | null;
  driverName: string | null;
  driverPhone: string | null;
  vehiclePlate: string | null;
  /*
   * What is actually on the lorry. An agent checking a shipment is reconciling
   * it against their own purchase order, so "is this the 22 pallets I ordered"
   * is the second question they ask after "where is it" — and the one that
   * otherwise becomes a phone call to the desk.
   */
  carrierName: string | null;
  totalWeightKg: number | null;
  palletCount: number | null;
  cargoSummary: string | null;
  /** Order lines pre-aggregated by the query: "SKU x12 koli, SKU x4 koli". */
  itemList: string | null;
  /** GeoJSON FeatureCollection. Null unless show_route is set. */
  route: unknown | null;
}

/**
 * `unknown` covers both "no such token" and "revoked", and the controller must
 * render them identically. A distinct answer for revoked tells a holder of a
 * dead link that the link was once real and points at a live session — and it
 * turns the endpoint into an oracle that confirms guesses.
 */
export type ShareResolution =
  | { kind: 'ok'; view: ConsigneeView }
  | { kind: 'expired' }
  | { kind: 'unknown' };

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
  ) {}

  // ===========================================================================
  // Dispatcher surface
  // ===========================================================================

  /**
   * Mint a link. The token is returned exactly once, here, and never again:
   * only its sha256 is stored, so there is no query that can recover it. A
   * dispatcher who loses the message mints a new link and revokes the old one.
   */
  async mint(sessionId: string, dto: CreateShareLinkDto, userId: string) {
    const session = await this.db.maybeOne<{ order_id: string | null }>(
      `SELECT order_id FROM kh.tracking_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) {
      throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });
    }
    /*
     * order_id is nullable, and kh.v_live_fleet inner-joins the order. A link
     * minted against an orderless session would resolve to no row at view time
     * and the consignee would be shown the "invalid link" page — a failure that
     * looks like a revoked token and would be debugged as one. Fail here, where
     * the person who can fix it is the person reading the error.
     */
    if (!session.order_id) {
      throw new ConflictException({
        code: 'SESSION_HAS_NO_ORDER',
        message: 'Session is not attached to an order, so there is nothing to show a consignee',
      });
    }

    const token = randomToken(TOKEN_BYTES);

    // maybeOne, not one: this is an INSERT … SELECT, so a session cancelled and
    // hard-deleted between the check above and here legitimately inserts zero
    // rows. That is a 404, not the opaque "Expected exactly 1 row" a 500 would
    // hand the dispatcher.
    const row = await this.db.maybeOne<{
      id: string;
      created_at: Date;
      expires_at: Date;
      show_route: boolean;
      show_driver: boolean;
      label: string | null;
    }>(
      `INSERT INTO kh.share_links (
         session_id, token_hash, token_enc, show_route, show_driver, label, created_by, expires_at
       )
       SELECT $1, $2, $8, $3, $4, $5, $6,
              CASE
                WHEN $7::int IS NOT NULL THEN now() + make_interval(hours => $7::int)
                /*
                 * Default: the session's own hard lifetime cap, plus a week.
                 *
                 * The link has to outlive the shipment. The consignee's most
                 * likely moment to open it is when the goods land — or when
                 * they fail to — and a capability that dies the instant the
                 * session closes goes dark at exactly that moment, which puts
                 * the telephone call back on the dispatcher and is the whole
                 * thing this feature exists to stop. A week past the cap
                 * absorbs a lorry sitting in the Habur queue over a weekend
                 * and still leaves the link mortal.
                 *
                 * Floored at 24 h from now for two reasons: a link minted
                 * against an almost-expired session is otherwise born useless,
                 * and ck_share_expiry (expires_at > created_at) would reject
                 * the row outright for a session already past its cap.
                 */
                ELSE greatest(s.expires_at, now() + interval '24 hours') + interval '7 days'
              END
       FROM kh.tracking_sessions s
       WHERE s.id = $1
       RETURNING id, created_at, expires_at, show_route, show_driver, label`,
      [
        sessionId,
        sha256(token),
        dto.showRoute ?? false,
        /*
         * Driver and plate default ON; the route trace defaults OFF.
         *
         * They are different things. A consignee waiting at a gate in Erbil
         * needs the plate to recognise the lorry and the driver's number to
         * call when it is outside — withholding that just moves the phone call
         * to the dispatcher, which is the cost this whole feature exists to
         * remove. The full movement trace is the sensitive one: it is a log of
         * where a third party's employee has been all day, and no consignee
         * needs it to know when their goods arrive.
         *
         * Still a flag, so a dispatcher can close it for a shipment where it
         * matters.
         */
        dto.showDriver ?? true,
        dto.label ?? null,
        userId,
        dto.expiresInHours ?? null,
        /*
         * $8 — the token, encrypted under the same key and helper the driver
         * ingest keys already use. This is what lets a dispatcher read the
         * link back later; see migration 0010 for why hashing alone was the
         * wrong call for a capability of this risk class.
         */
        encryptSecret(Buffer.from(token, 'utf8'), this.config.auth.ingestKeyEncryptionKey),
      ],
    );
    if (!row) {
      throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Unknown session' });
    }

    return {
      id: row.id,
      /** Shown once. Nothing on this server can reproduce it after this response. */
      url: `${this.config.publicApiUrl}/s/${token}`,
      label: row.label,
      showRoute: row.show_route,
      showDriver: row.show_driver,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * The links on a session, so a dispatcher can answer "did the customer ever
   * look" before the customer phones to ask.
   *
   * token_hash is not in the projection and must not be added to it. There is
   * nothing a dispatcher can do with it, and it is the one column whose leak
   * would let an attacker confirm a guessed token offline.
   */
  async list(sessionId: string) {
    const rows = await this.db.query<Record<string, unknown> & { id: string; token_enc: Buffer | null }>(
      `SELECT id,
              label,
              show_route     AS "showRoute",
              show_driver    AS "showDriver",
              created_at     AS "createdAt",
              expires_at     AS "expiresAt",
              revoked_at     AS "revokedAt",
              last_viewed_at AS "lastViewedAt",
              view_count     AS "viewCount",
              (revoked_at IS NULL AND expires_at > now()) AS "active",
              token_enc
       FROM kh.share_links
       WHERE session_id = $1
       ORDER BY created_at DESC`,
      [sessionId],
    );

    return rows.map(({ token_enc: enc, ...row }) => ({
      ...row,
      /*
       * Null for links minted before 0010, and for any ciphertext that will
       * not open — a rotated INGEST_KEY_SECRET, a truncated column. Those show
       * in the dashboard as un-recallable rather than throwing: one unreadable
       * historical row must not take down the panel listing the working ones.
       */
      url: enc ? this.decodeToken(row.id, enc) : null,
    }));
  }

  private decodeToken(linkId: string, enc: Buffer): string | null {
    try {
      const token = decryptSecret(enc, this.config.auth.ingestKeyEncryptionKey).toString('utf8');
      return `${this.config.publicApiUrl}/s/${token}`;
    } catch {
      this.logger.warn(`share link ${linkId}: token_enc could not be decrypted`);
      return null;
    }
  }

  /**
   * Revoke. Idempotent by construction — the coalesce keeps the first
   * revocation's timestamp, so a dispatcher clicking twice does not quietly
   * rewrite the record of when the customer lost access.
   */
  async revoke(shareId: string) {
    const row = await this.db.maybeOne<{ id: string; sessionId: string; revokedAt: Date }>(
      `UPDATE kh.share_links
          SET revoked_at = coalesce(revoked_at, now())
        WHERE id = $1
        RETURNING id, session_id AS "sessionId", revoked_at AS "revokedAt"`,
      [shareId],
    );
    if (!row) {
      throw new NotFoundException({ code: 'SHARE_LINK_NOT_FOUND', message: 'Unknown share link' });
    }
    return row;
  }

  // ===========================================================================
  // Public surface
  // ===========================================================================

  /**
   * Resolve a token to what its holder may see.
   *
   * The token is hashed and matched against the stored digest; the plaintext is
   * never stored and never logged. Constant-time comparison is not needed and
   * would not help: the lookup is an index probe on a 256-bit digest, so there
   * is no partial-match signal to time.
   */
  async resolve(rawToken: string): Promise<ShareResolution> {
    if (!TOKEN_SHAPE.test(rawToken ?? '')) return { kind: 'unknown' };

    const row = await this.db.maybeOne<{
      link_id: string;
      show_route: boolean;
      show_driver: boolean;
      expires_at: Date;
      revoked_at: Date | null;
      session_id: string;
      status: string;
      signal_state: string;
      order_number: string;
      order_status: string;
      customer_name: string;
      destination_label: string | null;
      destination_lat: number | null;
      destination_lon: number | null;
      planned_delivery_at: Date | null;
      lat: number | null;
      lon: number | null;
      recorded_at: Date | null;
      remaining_km: number | null;
      driver_name: string | null;
      driver_phone: string | null;
      vehicle_plate: string | null;
      carrier_name: string | null;
      total_weight_kg: number | null;
      pallet_count: number | null;
      cargo_summary: string | null;
      item_list: string | null;
    }>(
      /*
       * The driver columns are gated in SQL rather than dropped in TypeScript.
       *
       * Filtering after the fact works right up until someone adds a log line,
       * a debug dump or a second consumer of this row. Gating in the projection
       * means the driver's name and phone number never leave Postgres unless
       * the capability actually grants them, and there is no code path that can
       * forget.
       */
      `SELECT l.id            AS link_id,
              l.show_route,
              l.show_driver,
              l.expires_at,
              l.revoked_at,
              f.session_id,
              f.status::text  AS status,
              f.signal_state,
              f.order_number::text AS order_number,
              f.order_status::text AS order_status,
              f.customer_name,
              f.destination_label,
              f.destination_lat,
              f.destination_lon,
              f.planned_delivery_at,
              f.last_lat      AS lat,
              f.last_lon      AS lon,
              f.last_point_at AS recorded_at,
              f.remaining_km,
              CASE WHEN l.show_driver THEN f.driver_name   END AS driver_name,
              CASE WHEN l.show_driver THEN f.driver_phone  END AS driver_phone,
              CASE WHEN l.show_driver THEN f.vehicle_plate END AS vehicle_plate,
              -- The view calls it shipping_company_name; there is no carrier_name.
              f.shipping_company_name AS carrier_name,
              o.total_weight_kg,
              o.pallet_count,
              o.cargo_summary,
              /*
               * Aggregated in SQL rather than fetched as a second query: this
               * is the one request a consignee's phone makes, quite possibly
               * over 2G, and a round trip per shipment line is the difference
               * between a page that renders and one they close.
               */
              (SELECT string_agg(
                        i.sku || CASE WHEN i.quantity IS NOT NULL
                                      THEN ' x' || i.quantity::text || ' ' || i.unit
                                      ELSE '' END,
                        ', ' ORDER BY i.sku)
                 FROM kh.order_items i
                WHERE i.order_id = f.order_id)          AS item_list
       FROM kh.share_links l
       JOIN kh.v_live_fleet f ON f.session_id = l.session_id
       JOIN kh.orders       o ON o.id = f.order_id
       WHERE l.token_hash = $1`,
      [sha256(rawToken)],
    );

    // Unknown and revoked collapse into one answer on purpose. See ShareResolution.
    if (!row || row.revoked_at) return { kind: 'unknown' };
    if (row.expires_at.getTime() <= Date.now()) return { kind: 'expired' };

    const route = row.show_route ? await this.routeFor(row.session_id) : null;

    this.recordView(row.link_id);

    return {
      kind: 'ok',
      view: {
        linkId: row.link_id,
        showRoute: row.show_route,
        showDriver: row.show_driver,
        status: row.status,
        signalState: row.signal_state,
        orderNumber: row.order_number,
        orderStatus: row.order_status,
        customerName: row.customer_name,
        destinationLabel: row.destination_label,
        destinationLat: row.destination_lat,
        destinationLon: row.destination_lon,
        plannedDeliveryAt: row.planned_delivery_at,
        lat: row.lat,
        lon: row.lon,
        recordedAt: row.recorded_at,
        remainingKm: row.remaining_km,
        driverName: row.driver_name,
        driverPhone: row.driver_phone,
        vehiclePlate: row.vehicle_plate,
        carrierName: row.carrier_name,
        totalWeightKg: row.total_weight_kg,
        palletCount: row.pallet_count,
        cargoSummary: row.cargo_summary,
        itemList: row.item_list,
        route,
      },
    };
  }

  /**
   * Coarser than the dispatcher's route: 25 m tolerance against their 8 m, and
   * simplification forced from 500 points rather than 5,000.
   *
   * The dispatcher is looking for which side of a junction a truck took on a
   * desktop. The consignee is looking at a line across a country on a phone in
   * Basra, where every vertex is bytes over a link that may be 2G. At that zoom
   * the two renders are indistinguishable and one of them is a tenth the size.
   *
   * This is the one genuinely expensive thing on an unauthenticated path —
   * ST_MakeLine over every fix in the session, on every page load. It is opt-in
   * (show_route defaults off) and the 60/min IP window is the ceiling; if a
   * carrier ever starts handing route-enabled links to a hundred consignees,
   * this is the query to put behind a short Redis cache, not the page.
   */
  private async routeFor(sessionId: string): Promise<unknown> {
    const row = await this.db.one<{ route: unknown }>(
      `SELECT kh.session_route($1::uuid, 25, NULL, NULL, 500) AS route`,
      [sessionId],
    );
    return row.route;
  }

  /**
   * Deliberately not awaited.
   *
   * The counter answers a dispatcher's question — "have they opened it, or are
   * they about to phone me" — and is worth nothing to the person waiting on the
   * page. Awaiting it would put a write on the critical path of an
   * unauthenticated request served over a phone link from Iraq, and a slow or
   * failed UPDATE would then turn into a slow or failed page for a customer.
   * A lost increment costs nobody anything.
   */
  private recordView(linkId: string): void {
    void this.db
      .query(
        `UPDATE kh.share_links
            SET view_count = view_count + 1, last_viewed_at = now()
          WHERE id = $1`,
        [linkId],
      )
      .catch((err: Error) => {
        this.logger.warn(`share view counter failed for ${linkId}: ${err.message}`);
      });
  }
}
