import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Structured error codes for all /api routes.
 * See #967: structured error format with codes.
 */
export enum ApiErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

/**
 * Wire format emitted by the error handler for every /api route.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
  };
}

const DEFAULT_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  [ApiErrorCode.BAD_REQUEST]: 400,
  [ApiErrorCode.UNAUTHORIZED]: 401,
  [ApiErrorCode.FORBIDDEN]: 403,
  [ApiErrorCode.NOT_FOUND]: 404,
  [ApiErrorCode.CONFLICT]: 409,
  [ApiErrorCode.VALIDATION_ERROR]: 422,
  [ApiErrorCode.RATE_LIMITED]: 429,
  [ApiErrorCode.INTERNAL_ERROR]: 500,
  [ApiErrorCode.SERVICE_UNAVAILABLE]: 503,
};

/**
 * Error type thrown by route handlers to produce a structured API error.
 */
export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? DEFAULT_STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }

  static badRequest(message = 'Bad request', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.BAD_REQUEST, message, undefined, details);
  }

  static unauthorized(message = 'Unauthorized', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.UNAUTHORIZED, message, undefined, details);
  }

  static forbidden(message = 'Forbidden', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.FORBIDDEN, message, undefined, details);
  }

  static notFound(message = 'Not found', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.NOT_FOUND, message, undefined, details);
  }

  static conflict(message = 'Conflict', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.CONFLICT, message, undefined, details);
  }

  static validation(message = 'Validation failed', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.VALIDATION_ERROR, message, undefined, details);
  }

  static rateLimited(message = 'Too many requests', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.RATE_LIMITED, message, undefined, details);
  }

  static internal(message = 'Internal server error', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.INTERNAL_ERROR, message, undefined, details);
  }

  static serviceUnavailable(message = 'Service unavailable', details?: unknown): ApiError {
    return new ApiError(ApiErrorCode.SERVICE_UNAVAILABLE, message, undefined, details);
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
      },
    };
  }
}

/**
 * Request augmented with a stable requestId used in error responses.
 */
export interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * Resolve (or lazily assign) a requestId for the given request.
 * Prefers an upstream-provided id (e.g. from a proxy) when present.
 */
export function getRequestId(req: RequestWithId): string {
  if (req.requestId) {
    return req.requestId;
  }

  const headerId =
    (req.headers['x-request-id'] as string | undefined) ??
    (req.headers['x-correlation-id'] as string | undefined);

  const requestId = headerId && headerId.trim() !== '' ? headerId : randomUUID();
  req.requestId = requestId;
  return requestId;
}

/**
 * Middleware that assigns a requestId to every request and echoes it back
 * via the `x-request-id` response header.
 */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const requestId = getRequestId(req);
  res.setHeader('x-request-id', requestId);
  next();
}

function isApiRequest(req: Request): boolean {
  const path = req.originalUrl || req.url || '';
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Single Express error-handling middleware for all /api routes.
 * Emits `{ error: { code, message, requestId } }`.
 *
 * Must be registered after all routes.
 */
export function apiErrorHandler(
  err: unknown,
  req: RequestWithId,
  res: Response,
  next: NextFunction,
): void {
  // If headers already sent, defer to the default Express handler.
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = getRequestId(req);

  let apiError: ApiError;
  if (err instanceof ApiError) {
    apiError = err;
  } else if (err instanceof Error) {
    apiError = new ApiError(ApiErrorCode.INTERNAL_ERROR, err.message || 'Internal server error');
  } else {
    apiError = new ApiError(ApiErrorCode.INTERNAL_ERROR, 'Internal server error');
  }

  // Non-/api routes fall through to the default handler.
  if (!isApiRequest(req)) {
    next(err);
    return;
  }

  // Avoid leaking internal error details in production.
  const message =
    apiError.code === ApiErrorCode.INTERNAL_ERROR && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : apiError.message;

  const body: ApiErrorBody = {
    error: {
      code: apiError.code,
      message,
      requestId,
    },
  };

  res.status(apiError.status).json(body);
}

/**
 * Wrap an async route handler so rejected promises are forwarded to the
 * error handler.
 */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): (req: T, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default apiErrorHandler;