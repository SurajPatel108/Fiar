import { FiarApiError, FiarClient } from '../../../packages/sdk/src/index';

export function createDashboardClient(credential: string): FiarClient {
  return new FiarClient({
    baseUrl: '',
    credential,
  });
}

export function describeDashboardError(error: unknown): { kind: 'conflict' | 'error'; message: string } {
  if (error instanceof FiarApiError) {
    if (error.status === 409) {
      return {
        kind: 'conflict',
        message: 'This approval changed or expired before the decision was accepted. The latest record has been refreshed.',
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        kind: 'error',
        message: 'This credential is missing, invalid, or not authorized for manager approvals.',
      };
    }
    return { kind: 'error', message: error.message };
  }
  return { kind: 'error', message: 'The dashboard could not reach the Fiar gateway.' };
}
