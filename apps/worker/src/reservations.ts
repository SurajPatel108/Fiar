import type { PoolClient } from 'pg';

import { createId } from '../../../packages/shared/src/ids';

export interface ReservationRequest {
  tenantId: string;
  actionId: string;
  orderFactId: string;
  amountMinor: number;
  currency: 'USD';
}

export type ReservationResult =
  | { reserved: true; reservationId: string }
  | { reserved: false; reason: string };

export async function reserveExecutionCapacity(
  client: PoolClient,
  request: ReservationRequest,
): Promise<ReservationResult> {
  const existing = await client.query<{ id: string; status: string }>(
    `select id, status from execution_reservations where action_id = $1 and tenant_id = $2 limit 1`,
    [request.actionId, request.tenantId],
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    if (existingRow.status === 'reserved') {
      return { reserved: true, reservationId: existingRow.id };
    }
    if (existingRow.status === 'consumed') {
      return { reserved: false, reason: 'RESERVATION_CONSUMED' };
    }
  }

  const facts = await client.query<{
    active: boolean;
    status: string;
    currency: string;
    refundable_remaining_minor: string | number;
    budget_available_minor: string | number;
  }>(
    `
      select active, status, currency, refundable_remaining_minor, budget_available_minor
      from order_facts
      where id = $1 and tenant_id = $2
      for update
    `,
    [request.orderFactId, request.tenantId],
  );
  const row = facts.rows[0];
  if (!row || !row.active || !['open', 'partially_refunded'].includes(row.status)) {
    return { reserved: false, reason: 'ORDER_NOT_EXECUTABLE' };
  }
  if (row.currency !== request.currency) {
    return { reserved: false, reason: 'ORDER_CURRENCY_CHANGED' };
  }
  const remaining = Number(row.refundable_remaining_minor);
  const budget = Number(row.budget_available_minor);
  if (!Number.isSafeInteger(remaining) || !Number.isSafeInteger(budget)) {
    return { reserved: false, reason: 'INVALID_ORDER_BALANCE' };
  }
  if (request.amountMinor > remaining) {
    return { reserved: false, reason: 'REFUNDABLE_BALANCE_EXHAUSTED' };
  }
  if (request.amountMinor > budget) {
    return { reserved: false, reason: 'EXECUTION_BUDGET_EXHAUSTED' };
  }

  const reservationId = existingRow?.id ?? createId('rsv');
  await client.query(
    `
      update order_facts
      set refundable_remaining_minor = refundable_remaining_minor - $1,
          budget_available_minor = budget_available_minor - $1,
          updated_at = now()
      where id = $2 and tenant_id = $3
    `,
    [request.amountMinor, request.orderFactId, request.tenantId],
  );
  if (existingRow) {
    await client.query(
      `
        update execution_reservations
        set status = 'reserved', updated_at = now()
        where id = $1
      `,
      [reservationId],
    );
  } else {
    await client.query(
      `
        insert into execution_reservations (
          id, tenant_id, action_id, order_fact_id, amount_minor, status
        ) values ($1, $2, $3, $4, $5, 'reserved')
      `,
      [reservationId, request.tenantId, request.actionId, request.orderFactId, request.amountMinor],
    );
  }
  return { reserved: true, reservationId };
}

export async function consumeExecutionReservation(
  client: PoolClient,
  tenantId: string,
  actionId: string,
): Promise<void> {
  const reservation = await client.query<{ order_fact_id: string; amount_minor: string | number; status: string }>(
    `
      select order_fact_id, amount_minor, status
      from execution_reservations
      where tenant_id = $1 and action_id = $2
      for update
    `,
    [tenantId, actionId],
  );
  const row = reservation.rows[0];
  if (!row || row.status !== 'reserved') {
    return;
  }
  await client.query(
    `
      update execution_reservations
      set status = 'consumed', updated_at = now()
      where tenant_id = $1 and action_id = $2
    `,
    [tenantId, actionId],
  );
  await client.query(
    `
      update order_facts
      set previous_refund_total_minor = previous_refund_total_minor + $1,
          status = case when refundable_remaining_minor = 0 then 'refunded' else 'partially_refunded' end,
          updated_at = now()
      where id = $2 and tenant_id = $3
    `,
    [Number(row.amount_minor), row.order_fact_id, tenantId],
  );
}

export async function releaseExecutionReservation(
  client: PoolClient,
  tenantId: string,
  actionId: string,
): Promise<void> {
  const reservation = await client.query<{ order_fact_id: string; amount_minor: string | number; status: string }>(
    `
      select order_fact_id, amount_minor, status
      from execution_reservations
      where tenant_id = $1 and action_id = $2
      for update
    `,
    [tenantId, actionId],
  );
  const row = reservation.rows[0];
  if (!row || row.status !== 'reserved') {
    return;
  }
  await client.query(
    `
      update order_facts
      set refundable_remaining_minor = refundable_remaining_minor + $1,
          budget_available_minor = budget_available_minor + $1,
          updated_at = now()
      where id = $2 and tenant_id = $3
    `,
    [Number(row.amount_minor), row.order_fact_id, tenantId],
  );
  await client.query(
    `
      update execution_reservations
      set status = 'released', updated_at = now()
      where tenant_id = $1 and action_id = $2
    `,
    [tenantId, actionId],
  );
}
