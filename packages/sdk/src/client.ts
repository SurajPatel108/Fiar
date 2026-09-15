import type {
  Action,
  ActionListOptions,
  Approval,
  ApprovalBinding,
  ApprovalDecisionRequest,
  ApprovalListOptions,
  BoundDecisionOptions,
  CredentialHeaders,
  FiarClientOptions,
  FiarErrorResponse,
  FetchTransport,
  Page,
  SubmitRefundActionRequest,
} from './types';

export class FiarApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FiarApiError';
  }
}

export class FiarTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiarTransportError';
  }
}

export class FiarClient {
  private readonly baseUrl: string;
  private readonly transport: FetchTransport;

  constructor(private readonly options: FiarClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  submitAction(request: SubmitRefundActionRequest): Promise<Action> {
    return this.request<Action>('POST', '/v1/actions', request);
  }

  getAction(actionId: string): Promise<Action> {
    return this.request<Action>('GET', `/v1/actions/${encodeURIComponent(actionId)}`);
  }

  listActions(options: ActionListOptions = {}): Promise<Page<Action>> {
    return this.request<Page<Action>>('GET', `/v1/actions${buildQuery(options)}`);
  }

  listApprovals(options: ApprovalListOptions = {}): Promise<Page<Approval>> {
    return this.request<Page<Approval>>('GET', `/v1/approvals${buildQuery(options)}`);
  }

  getApproval(approvalId: string): Promise<Approval> {
    return this.request<Approval>('GET', `/v1/approvals/${encodeURIComponent(approvalId)}`);
  }

  decideApproval(approvalId: string, decision: ApprovalDecisionRequest): Promise<Approval> {
    return this.request<Approval>(
      'POST',
      `/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      decision,
    );
  }

  approveApproval(binding: ApprovalBinding, options: BoundDecisionOptions = {}): Promise<Approval> {
    return this.decideBoundApproval(binding, 'approve', options);
  }

  rejectApproval(binding: ApprovalBinding, options: BoundDecisionOptions = {}): Promise<Approval> {
    return this.decideBoundApproval(binding, 'reject', options);
  }

  private decideBoundApproval(
    binding: ApprovalBinding,
    decision: 'approve' | 'reject',
    options: BoundDecisionOptions,
  ): Promise<Approval> {
    return this.decideApproval(binding.approvalId, {
      decision,
      comment: options.comment ?? null,
      expectedRequestHash: binding.requestHash,
      expectedPolicyVersion: binding.policyVersionId,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.resolveHeaders(body !== undefined);
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new FiarTransportError('Unable to reach the Fiar gateway');
    }

    let payload: unknown;
    try {
      payload = await readJson(response);
    } catch (error) {
      if (error instanceof FiarTransportError) {
        throw error;
      }
      throw new FiarTransportError('Unable to read the Fiar gateway response');
    }
    if (!response.ok) {
      const apiError = isErrorResponse(payload) ? payload : null;
      throw new FiarApiError(
        response.status,
        apiError?.error ?? 'HTTP_ERROR',
        apiError?.message ?? `Fiar gateway returned HTTP ${response.status}`,
      );
    }
    return payload as T;
  }

  private async resolveHeaders(hasBody: boolean): Promise<Record<string, string>> {
    const dynamicHeaders = await this.options.getCredentialHeaders?.();
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.options.headers,
      ...dynamicHeaders,
    };
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }
    if (this.options.credential !== undefined) {
      headers[this.options.credentialHeader ?? 'x-fiar-dev-credential'] = this.options.credential;
    }
    return headers;
  }
}

function buildQuery(options: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) {
      return null;
    }
    throw new FiarTransportError('Fiar gateway returned an invalid JSON response');
  }
}

function isErrorResponse(value: unknown): value is FiarErrorResponse {
  return typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).error === 'string' &&
    typeof (value as Record<string, unknown>).message === 'string';
}

export type { CredentialHeaders };
