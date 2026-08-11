import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Uniform error envelope.
 *
 * Every failure the Android app can see carries a stable machine-readable
 * `code`, because the client's retry policy branches on it:
 *
 *   TOKEN_EXPIRED   → refresh, then retry the batch
 *   SESSION_CLOSED  → stop the service, keep the buffer, tell the driver
 *   RATE_LIMITED    → back off for `retryAfterSec`
 *   BATCH_TOO_LARGE → re-chunk and retry
 *   5xx / network   → exponential backoff, keep buffering
 *
 * Free-text messages are for humans and may change; codes are the contract.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong on our side';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = defaultCodeFor(status);
      } else if (body && typeof body === 'object') {
        const obj = body as Record<string, unknown>;
        code = typeof obj.code === 'string' ? obj.code : defaultCodeFor(status);
        message = Array.isArray(obj.message)
          ? (obj.message as string[]).join('; ')
          : typeof obj.message === 'string'
            ? obj.message
            : defaultMessageFor(status);
        const { code: _c, message: _m, statusCode: _s, error: _e, ...rest } = obj;
        if (Object.keys(rest).length) details = rest;
      }
    } else {
      const pgCode = (exception as { code?: string }).code;
      // Surface database constraint violations as 4xx instead of a blank 500.
      if (pgCode === '23505') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE';
        message = 'That record already exists';
      } else if (pgCode === '23503') {
        status = HttpStatus.BAD_REQUEST;
        code = 'FOREIGN_KEY';
        message = 'Referenced record does not exist';
      } else if (pgCode === '22P02') {
        status = HttpStatus.BAD_REQUEST;
        code = 'INVALID_INPUT';
        message = 'Malformed value in request';
      } else if (pgCode === 'P0002') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = (exception as Error).message;
      } else if (pgCode === '55P03' || pgCode === '57014') {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        code = 'DB_BUSY';
        message = 'Database is busy, retry shortly';
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} ${code}`,
        (exception as Error)?.stack,
      );
    } else if (status !== 404) {
      this.logger.warn(`${request.method} ${request.url} → ${status} ${code}: ${message}`);
    }

    void reply.status(status).send({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      // Always present so a device with a bad clock can self-correct even from
      // an error response (ADR-011).
      serverTime: Math.floor(Date.now() / 1000),
      path: request.url,
    });
  }
}

function defaultCodeFor(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 413: return 'PAYLOAD_TOO_LARGE';
    case 429: return 'RATE_LIMITED';
    case 503: return 'UNAVAILABLE';
    default:  return 'ERROR';
  }
}

function defaultMessageFor(status: number): string {
  return status >= 500 ? 'Something went wrong on our side' : 'Request could not be processed';
}
