import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Driver, Public } from '../auth/decorators';
import { DriverSessionGuard } from '../auth/guards/driver-session.guard';
import { IngestService } from './ingest.service';
import { IngestBatchDto, IngestPingDto } from './dto';
import type { DriverContext, KhRequest } from '../auth/auth.types';

/**
 * The truck-facing write API.
 *
 * @Public() removes the dispatcher guard; DriverSessionGuard replaces it with
 * session-scoped JWT + HMAC verification (ADR-009). Both endpoints share one
 * service method — a "ping" is simply a batch of one, which means there is
 * exactly one code path to reason about and to test.
 */
@Controller('ingest')
@Public()
@UseGuards(DriverSessionGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /**
   * Offline flush and normal micro-batching.
   *
   * 202 rather than 200: the points are durably committed, but the realtime
   * fan-out that follows is asynchronous.
   */
  @Post('batch')
  @HttpCode(202)
  batch(@Body() dto: IngestBatchDto, @Driver() driver: DriverContext, @Req() req: KhRequest) {
    return this.ingest.ingest(
      driver,
      {
        batchId: dto.batchId,
        offline: dto.offline,
        bufferRemaining: dto.bufferRemaining,
        points: dto.points,
      },
      { ip: req.ip, bodyBytes: req.rawBody?.length ?? 0 },
    );
  }

  /** Single realtime fix. Kept separate purely so the wire payload stays small. */
  @Post('ping')
  @HttpCode(202)
  ping(@Body() dto: IngestPingDto, @Driver() driver: DriverContext, @Req() req: KhRequest) {
    return this.ingest.ingest(
      driver,
      { batchId: dto.batchId, offline: false, points: [dto.point] },
      { ip: req.ip, bodyBytes: req.rawBody?.length ?? 0 },
    );
  }
}
