import { isDomainError, type DomainError } from '../../../packages/shared/src/errors';

export interface HttpErrorPayload {
  error: string;
  message: string;
}

export function mapDomainErrorToStatusCode(error: DomainError): number {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'INVALID_REQUEST':
      return 400;
    default:
      return 500;
  }
}

export function toHttpErrorPayload(error: unknown): HttpErrorPayload {
  if (isDomainError(error)) {
    return {
      error: error.code,
      message: error.message,
    };
  }

  if (error instanceof TypeError) {
    return {
      error: 'INVALID_REQUEST',
      message: error.message,
    };
  }

  return {
    error: 'INTERNAL_ERROR',
    message: 'Unexpected error',
  };
}
