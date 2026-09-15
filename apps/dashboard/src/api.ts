import { FiarApiError, FiarClient, FiarTransportError, type Approval } from '@fiar/sdk';

export type DashboardNotice = { kind: 'conflict' | 'expired' | 'error'; message: string };

type ApprovalListClient = Pick<FiarClient, 'listApprovals'>;

export function createDashboardClient(credential: string): FiarClient {
  return new FiarClient({
    baseUrl: '',
    credential,
  });
}

export async function listAllPendingApprovals(client: ApprovalListClient): Promise<Approval[]> {
  const approvals: Approval[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await client.listApprovals({ status: 'pending', limit: 100, ...(cursor ? { cursor } : {}) });
    approvals.push(...page.items);
    if (page.nextCursor === null) {
      return approvals;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new FiarTransportError('Fiar gateway returned a repeated approval cursor');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
}

export function describeDashboardError(error: unknown): DashboardNotice {
  if (error instanceof FiarApiError) {
    if (error.status === 409) {
      return {
        kind: 'conflict',
        message: 'This approval changed before the decision was accepted. Refresh and review its current status.',
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

export function describeDecisionError(error: unknown, latest: Approval | null): DashboardNotice {
  if (latest?.status === 'expired') {
    return {
      kind: 'expired',
      message: `This approval is expired and cannot be decided${latest.resolutionReason ? ` (${latest.resolutionReason})` : ''}.`,
    };
  }
  if (latest?.status === 'approved' || latest?.status === 'rejected') {
    return {
      kind: 'conflict',
      message: `This approval was already ${latest.status}. The refreshed detail is shown.`,
    };
  }
  return describeDashboardError(error);
}
