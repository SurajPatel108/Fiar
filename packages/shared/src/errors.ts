export type DomainErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_STATE_TRANSITION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'POLICY_DENIED';

export interface DomainErrorDetails {
  [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails | undefined;

  constructor(code: DomainErrorCode, message: string, details?: DomainErrorDetails) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
