import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { DriverSessionGuard } from '../auth/guards/driver-session.guard';
import { Driver, Public } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit.guard';
import { DatabaseService } from '../database/database.service';
import { SessionsService } from './sessions.service';
import { ClaimSessionDto, DriverEventDto, DriverRefreshDto } from './dto';
import type { DriverContext, KhRequest } from '../auth/auth.types';

/**
 * The only surface the Android app talks to besides /ingest.
 *
 * `claim` and `token/refresh` are @Public because the device has no credential
 * yet (claim) or an expired one (refresh); both authenticate against secrets in
 * the request body instead.
 */
@Controller('driver')
export class DriverController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * Exchange a claim code for a session-scoped credential set.
   *
   * 20 attempts per IP per minute is far above what a real driver needs — they
   * type one code, twice at worst — and far below what makes hammering an
   * unauthenticated database-touching endpoint worthwhile. The per-code window
   * is tighter still and cannot be evaded by rotating source addresses.
   */
  @Public()
  @RateLimit({ bucket: 'claim', perIp: 20, perSubject: 10, subjectField: 'code', windowSec: 60 })
  @Post('claim')
  @HttpCode(200)
  claim(@Body() dto: ClaimSessionDto, @Req() req: KhRequest) {
    return this.sessions.claim(dto, req.ip);
  }

  /**
   * Silent re-auth when the 24 h access token expires mid-haul.
   *
   * Roomier than claim: a truck coming out of a dead zone can legitimately
   * retry several times in quick succession while the radio settles.
   */
  @Public()
  @RateLimit({ bucket: 'drvrefresh', perIp: 60, windowSec: 60 })
  @Post('token/refresh')
  @HttpCode(200)
  refresh(@Body() dto: DriverRefreshDto) {
    return this.sessions.refreshDriverToken(dto);
  }

  /**
   * Called on app start and after every service restart. Confirms the session is
   * still open, hands back the current policy, and — crucially — returns
   * `serverTime` so the device can compute its clock offset before signing
   * anything (ADR-011).
   */
  @Public()
  @UseGuards(DriverSessionGuard)
  @Get('session')
  async currentSession(@Driver() driver: DriverContext) {
    const row = await this.db.one(
      `SELECT s.id            AS "sessionId",
              s.reference,
              s.status::text  AS status,
              s.started_at    AS "startedAt",
              s.points_total  AS "pointsTotal",
              round(s.distance_m::numeric / 1000, 2) AS "distanceKm",
              s.ping_interval_sec AS "pingIntervalSec",
              s.idle_interval_sec AS "idleIntervalSec",
              s.min_distance_m    AS "minDistanceM",
              o.order_number::text AS "orderNumber",
              o.cargo_summary      AS "cargoSummary",
              o.destination_label  AS "destinationLabel",
              o.destination_address AS "destinationAddress",
              ST_Y(o.destination::geometry) AS "destinationLat",
              ST_X(o.destination::geometry) AS "destinationLon",
              o.destination_radius_m        AS "destinationRadiusM",
              o.planned_delivery_at AS "plannedDeliveryAt",
              c.name               AS "customerName",
              c.contact_phone      AS "customerPhone"
       FROM kh.tracking_sessions s
       JOIN kh.orders    o ON o.id = s.order_id
       JOIN kh.customers c ON c.id = o.customer_id
       WHERE s.id = $1`,
      [driver.sessionId],
    );
    return { ...row, serverTime: Math.floor(Date.now() / 1000) };
  }

  /** Lifecycle + diagnostics: STARTED, GPS_LOST, SERVICE_KILLED, BUFFER_OVERFLOW… */
  @Public()
  @UseGuards(DriverSessionGuard)
  @Post('events')
  @HttpCode(202)
  event(@Body() dto: DriverEventDto, @Driver() driver: DriverContext) {
    return this.sessions.recordDriverEvent(driver.sessionId, dto);
  }

  /**
   * Driver-initiated stop. Deliberately does NOT complete the order — only a
   * dispatcher marks a delivery done. This just parks the session so the phone
   * can stop the foreground service cleanly.
   */
  @Public()
  @UseGuards(DriverSessionGuard)
  @Post('stop')
  @HttpCode(200)
  stop(@Driver() driver: DriverContext) {
    return this.sessions.transition(driver.sessionId, 'pause', 'device', 'Driver stopped tracking');
  }
}
