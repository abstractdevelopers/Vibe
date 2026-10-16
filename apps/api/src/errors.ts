/**
 * Consistent API error envelope: machine-readable code, human-readable
 * message, request id, and optional field errors. Never leak internals.
 */
export type ErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "idempotency_conflict"
  | "provider_unavailable"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  idempotency_conflict: 409,
  provider_unavailable: 503,
  internal_error: 500,
};

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: FieldError[];

  constructor(code: ErrorCode, message: string, fieldErrors?: FieldError[]) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.fieldErrors = fieldErrors;
  }

  static badRequest(message: string): ApiError {
    return new ApiError("bad_request", message);
  }

  static unauthorized(message = "Authentication required"): ApiError {
    return new ApiError("unauthorized", message);
  }

  static forbidden(message = "Not allowed"): ApiError {
    return new ApiError("forbidden", message);
  }

  static notFound(message = "Not found"): ApiError {
    return new ApiError("not_found", message);
  }

  static conflict(message: string): ApiError {
    return new ApiError("conflict", message);
  }

  static tooManyRequests(message = "Too many requests"): ApiError {
    return new ApiError("rate_limited", message);
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    fieldErrors?: FieldError[];
  };
}

export function errorBody(error: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    },
  };
}
