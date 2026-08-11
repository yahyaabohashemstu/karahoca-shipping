import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsISO8601, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { TrackingService } from './tracking.service';

class RouteQueryDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(500)
  toleranceM?: number;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  @IsOptional() @Type(() => Boolean) @IsBoolean()
  raw?: boolean;

  // Floor of 10, not 100: a caller building a sparkline or a thumbnail route
  // legitimately wants a handful of points, and the decimation stride handles
  // any value fine.
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(20000)
  maxPoints?: number;
}

class GapsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(30) @Max(86400)
  minGapSec?: number;
}

@Controller('tracking')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  /** Snapshot for the live map. The socket takes over after this. */
  @Get('live')
  live() {
    return this.tracking.liveFleet();
  }

  @Get('carriers/performance')
  carriers() {
    return this.tracking.carrierPerformance();
  }

  @Get('sessions/:id/route')
  route(@Param('id', ParseUUIDPipe) id: string, @Query() query: RouteQueryDto) {
    return this.tracking.route(id, query);
  }

  @Get('sessions/:id/playback')
  playback(@Param('id', ParseUUIDPipe) id: string, @Query() query: RouteQueryDto) {
    return this.tracking.playback(id, query);
  }

  @Get('sessions/:id/gaps')
  gaps(@Param('id', ParseUUIDPipe) id: string, @Query() query: GapsQueryDto) {
    return this.tracking.gaps(id, query.minGapSec ?? 120);
  }

  @Get('sessions/:id/speed-profile')
  speedProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.tracking.speedProfile(id);
  }

  /**
   * Full-fidelity NDJSON export.
   *
   * Streamed with a cursor so a 50,000-point session never materialises in the
   * API's heap — this endpoint must stay usable when someone is arguing about a
   * delivery in front of a lawyer.
   */
  @Get('sessions/:id/export.ndjson')
  async export(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    // Tell Fastify we are taking over the socket. Without hijack(), writing to
    // reply.raw while Fastify still believes the reply is pending produces
    // "Reply was already sent" errors and skips the onSend lifecycle.
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="karahoca-session-${id}.ndjson"`,
    );
    for await (const line of this.tracking.exportPoints(id)) {
      if (!reply.raw.write(line)) {
        await new Promise((resolve) => reply.raw.once('drain', resolve));
      }
    }
    reply.raw.end();
  }
}
