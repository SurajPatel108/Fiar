import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FiarApiError, type Approval, type ApprovalDecision } from '@fiar/sdk';
import {
  createDashboardClient,
  createSessionDashboardClient,
  describeDashboardError,
  describeDecisionError,
  listAllPendingApprovals,
  loadManagerSession,
  logoutManagerSession,
} from './api';
import type { FiarClient } from '@fiar/sdk';

interface Notice {
  kind: 'success' | 'conflict' | 'expired' | 'error';
  message: string;
}

export function App() {
  return import.meta.env.DEV || import.meta.env.VITE_FIAR_DASHBOARD_MODE === 'development'
    ? <DevelopmentApp /> : <ProductionApp />;
}

function DevelopmentApp() {
  const [credential, setCredential] = useState<string | null>(null);
  return credential === null
    ? <CredentialSetup onConnect={setCredential} />
    : <ApprovalDesk client={createDashboardClient(credential)} onDisconnect={() => setCredential(null)} />;
}

function ProductionApp() {
  const [session, setSession] = useState<{ principalType: 'manager' | 'admin'; csrfToken: string } | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const refreshSession = useCallback(async () => {
    const current = await loadManagerSession();
    setSession(current);
  }, []);
  useEffect(() => { void loadManagerSession().then(setSession).catch(() => setFailed(true)); }, []);
  if (failed) return <main className="setup-shell"><section className="setup-card"><h1>Approval Desk unavailable</h1><p>Manager authentication could not be reached.</p></section></main>;
  if (session === undefined) return <main className="setup-shell"><section className="setup-card"><p>Loading secure session…</p></section></main>;
  if (session === null) return <main className="setup-shell"><section className="setup-card"><span className="eyebrow">Fiar · secure manager session</span><h1>Approval Desk</h1><p className="lede">Sign in through your organization identity provider.</p><a className="button primary" href="/v1/auth/oidc/start">Sign in</a></section></main>;
  const client = createSessionDashboardClient(session.csrfToken);
  return <ApprovalDesk
    client={client}
    disconnectLabel="Sign out"
    onAuthenticationExpired={() => setSession(null)}
    onSessionRefresh={refreshSession}
    onDisconnect={() => { void logoutManagerSession(session.csrfToken).finally(() => setSession(null)); }}
  />;
}

function CredentialSetup({ onConnect }: { onConnect: (credential: string) => void }) {
  const [value, setValue] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.length > 0) {
      onConnect(value);
      setValue('');
    }
  }

  return (
    <main className="setup-shell">
      <section className="setup-card">
        <span className="eyebrow">Fiar · local development</span>
        <h1>Approval Desk</h1>
        <p className="lede">Review requests against their exact immutable policy binding.</p>
        <form onSubmit={submit}>
          <label htmlFor="manager-credential">Local manager credential</label>
          <input
            id="manager-credential"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Enter a development credential"
          />
          <button className="button primary" type="submit" disabled={value.length === 0}>Open desk</button>
        </form>
        <p className="local-warning">
          Local-only setup. The credential stays in this page's memory, is sent only to the proxied gateway,
          and is cleared when you reload or close the page.
        </p>
      </section>
    </main>
  );
}

function ApprovalDesk({ client, onDisconnect, disconnectLabel = 'Clear credential', onAuthenticationExpired, onSessionRefresh }: {
  client: FiarClient;
  onDisconnect: () => void;
  disconnectLabel?: string;
  onAuthenticationExpired?: () => void;
  onSessionRefresh?: () => Promise<void>;
}) {
  const stableClient = useMemo(() => client, [client]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<ApprovalDecision | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  const loadPending = useCallback(async () => {
    const request = ++listRequest.current;
    setListLoading(true);
    try {
      const items = await listAllPendingApprovals(stableClient);
      if (request === listRequest.current) {
        setApprovals(items);
      }
    } catch (error) {
      if (error instanceof FiarApiError && error.status === 401) onAuthenticationExpired?.();
      if (request === listRequest.current) {
        setNotice(describeDashboardError(error));
      }
    } finally {
      if (request === listRequest.current) {
        setListLoading(false);
      }
    }
  }, [stableClient]);

  const loadDetail = useCallback(async (approvalId: string): Promise<Approval | null> => {
    const request = ++detailRequest.current;
    setSelected(null);
    setDetailLoading(true);
    try {
      const approval = await stableClient.getApproval(approvalId);
      if (request === detailRequest.current) {
        setSelected(approval);
        return approval;
      }
    } catch (error) {
      if (error instanceof FiarApiError && error.status === 401) onAuthenticationExpired?.();
      if (request === detailRequest.current) {
        setNotice(describeDashboardError(error));
      }
    } finally {
      if (request === detailRequest.current) {
        setDetailLoading(false);
      }
    }
    return null;
  }, [stableClient]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  async function refresh() {
    setNotice(null);
    const selectedApprovalId = selected?.approvalId;
    await Promise.all([
      loadPending(),
      ...(selectedApprovalId ? [loadDetail(selectedApprovalId)] : []),
    ]);
  }

  async function confirmDecision() {
    if (!selected || !confirming) {
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const result = await stableClient.decideApproval(selected.approvalId, {
        decision: confirming,
        comment: comment.trim().length > 0 ? comment.trim() : null,
        expectedRequestHash: selected.requestHash,
        expectedPolicyVersion: selected.policyVersionId,
      });
      setSelected(result);
      setNotice({
        kind: 'success',
        message: confirming === 'approve'
          ? 'Approval recorded. The action is queued for controlled worker execution.'
          : 'Rejection recorded. No worker job was created.',
      });
      setConfirming(null);
      setComment('');
      await loadPending();
      await onSessionRefresh?.();
    } catch (error) {
      if (error instanceof FiarApiError && error.status === 401) onAuthenticationExpired?.();
      const failedApprovalId = selected.approvalId;
      setConfirming(null);
      const [, latest] = await Promise.all([
        loadPending(),
        loadDetail(failedApprovalId),
      ]);
      await onSessionRefresh?.().catch(() => onAuthenticationExpired?.());
      setNotice(describeDecisionError(error, latest));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Fiar · manager workspace</span>
          <h1>Approval Desk</h1>
        </div>
        <div className="topbar-actions">
          <button className="button secondary" type="button" onClick={() => void refresh()}>Refresh</button>
          <button className="button ghost" type="button" onClick={onDisconnect}>{disconnectLabel}</button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.kind}`} role="status">{notice.message}</div>}

      <main className="workspace">
        <section className="queue-panel" aria-label="Pending approvals">
          <div className="section-heading">
            <div>
              <p className="kicker">Queue</p>
              <h2>Pending approvals</h2>
            </div>
            <span className="count">{approvals.length}</span>
          </div>
          {listLoading ? (
            <p className="empty-state">Loading approvals…</p>
          ) : approvals.length === 0 ? (
            <p className="empty-state">Nothing needs review.</p>
          ) : (
            <ul className="approval-list">
              {approvals.map((approval) => (
                <li key={approval.approvalId}>
                  <button
                    className={selected?.approvalId === approval.approvalId ? 'approval-row selected' : 'approval-row'}
                    type="button"
                    onClick={() => void loadDetail(approval.approvalId)}
                  >
                    <span>
                      <strong>{approval.orderId}</strong>
                      <small>{approval.tool}</small>
                    </span>
                    <span className="row-meta">
                      <strong>{formatMoney(approval.amountMinor, approval.currency)}</strong>
                      <small>Expires {formatDate(approval.expiresAt)}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="detail-panel" aria-label="Approval detail">
          {detailLoading ? (
            <p className="empty-state">Loading exact request…</p>
          ) : selected ? (
            <ApprovalDetail
              approval={selected}
              onDecide={(decision) => {
                setComment('');
                setConfirming(decision);
              }}
            />
          ) : (
            <div className="detail-placeholder">
              <span className="placeholder-mark">↗</span>
              <h2>Select an approval</h2>
              <p>Inspect the immutable action, policy reason, and business facts before deciding.</p>
            </div>
          )}
        </section>
      </main>

      {confirming && selected && (
        <ConfirmationDialog
          decision={confirming}
          approval={selected}
          comment={comment}
          submitting={submitting}
          onComment={setComment}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void confirmDecision()}
        />
      )}
    </div>
  );
}

function ApprovalDetail({ approval, onDecide }: {
  approval: Approval;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  return (
    <article className="detail-card">
      <div className="detail-title">
        <div>
          <p className="kicker">Exact request</p>
          <h2>{formatMoney(approval.amountMinor, approval.currency)} refund</h2>
          <p className="muted">Order {approval.orderId}</p>
        </div>
        <span className={`status ${approval.status}`}>{approval.status.replace('_', ' ')}</span>
      </div>

      <section className="reason-card">
        <span>Policy reason</span>
        <strong>{approval.decisionReason}</strong>
      </section>

      <dl className="fact-grid">
        <Fact label="Tool" value={approval.tool} />
        <Fact label="Expires" value={formatDate(approval.expiresAt)} />
        <Fact label="Order fact version" value={approval.context.orderFactVersion} />
        <Fact label="Order active" value={formatBoolean(approval.context.orderActive)} />
        <Fact label="Refundable remaining" value={formatNullableMoney(approval.context.refundableRemainingMinor)} />
        <Fact label="Order exposure" value={formatNullableMoney(approval.context.orderExposureMinor)} />
        <Fact label="Budget available" value={formatNullableMoney(approval.context.budgetAvailableMinor)} />
        <Fact label="Action status" value={approval.actionStatus.replaceAll('_', ' ')} />
      </dl>

      <div className="binding-card">
        <div>
          <span>Request hash</span>
          <code>{approval.requestHash}</code>
        </div>
        <div>
          <span>Policy version</span>
          <code>{approval.policyVersionId}</code>
        </div>
      </div>

      {approval.status === 'pending' ? (
        <div className="decision-actions">
          <button className="button danger" type="button" onClick={() => onDecide('reject')}>Reject</button>
          <button className="button primary" type="button" onClick={() => onDecide('approve')}>Approve</button>
        </div>
      ) : (
        <p className="resolved-copy">
          Resolved as <strong>{approval.status}</strong>{approval.resolvedAt ? ` on ${formatDate(approval.resolvedAt)}` : ''}.
        </p>
      )}
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ConfirmationDialog({ decision, approval, comment, submitting, onComment, onCancel, onConfirm }: {
  decision: ApprovalDecision;
  approval: Approval;
  comment: string;
  submitting: boolean;
  onComment: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <span className="eyebrow">Confirm manager decision</span>
        <h2 id="confirm-title">{decision === 'approve' ? 'Approve' : 'Reject'} this refund?</h2>
        <p>
          This decision applies only to request <code>{shortHash(approval.requestHash)}</code> under policy{' '}
          <code>{approval.policyVersionId}</code>.
        </p>
        <label htmlFor="decision-comment">Comment (optional)</label>
        <textarea
          id="decision-comment"
          value={comment}
          onChange={(event) => onComment(event.target.value)}
          maxLength={1000}
          rows={4}
          placeholder="Add a concise review note"
        />
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className={decision === 'approve' ? 'button primary' : 'button danger'}
            type="button"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : `Confirm ${decision}`}
          </button>
        </div>
      </section>
    </div>
  );
}

function formatMoney(amountMinor: number, currency: 'USD' = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
}

function formatNullableMoney(amountMinor: number | null): string {
  return amountMinor === null ? 'Unavailable' : formatMoney(amountMinor);
}

function formatBoolean(value: boolean | null): string {
  return value === null ? 'Unavailable' : value ? 'Yes' : 'No';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
