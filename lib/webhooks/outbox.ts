import { getSystemDatabase } from '../auth/system-database';
import type { WebhookEventType, WebhookPayload, WebhookEvent } from './types';

const WEBHOOK_URL = process.env.WEBHOOK_URL;

export function isWebhookEnabled(): boolean {
  return !!WEBHOOK_URL;
}

export function enqueueEvent(eventType: WebhookEventType, payload: WebhookPayload): void {
  if (!isWebhookEnabled()) return;

  const db = getSystemDatabase();
  db.prepare(
    'INSERT INTO webhook_outbox (event_type, payload) VALUES (?, ?)'
  ).run(eventType, JSON.stringify(payload));
}

/**
 * As `enqueueEvent`, unless the same event is still waiting to be delivered: for an event that says
 * where something stands, so repeating it before the gateway has heard it adds nothing.
 */
export function enqueueEventOnce(eventType: WebhookEventType, payload: WebhookPayload): void {
  if (!isWebhookEnabled()) return;

  const body = JSON.stringify(payload);
  getSystemDatabase().prepare(
    `INSERT INTO webhook_outbox (event_type, payload)
     SELECT ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM webhook_outbox WHERE event_type = ? AND payload = ? AND delivered = 0 AND attempts < 10
     )`
  ).run(eventType, body, eventType, body);
}

export function getPendingEvents(limit = 50): WebhookEvent[] {
  const db = getSystemDatabase();
  return db.prepare(
    'SELECT * FROM webhook_outbox WHERE delivered = 0 AND attempts < 10 ORDER BY id ASC LIMIT ?'
  ).all(limit) as WebhookEvent[];
}

export function markDelivered(id: number): void {
  const db = getSystemDatabase();
  db.prepare(
    "UPDATE webhook_outbox SET delivered = 1, delivered_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function markFailed(id: number): void {
  const db = getSystemDatabase();
  db.prepare(
    "UPDATE webhook_outbox SET attempts = attempts + 1, last_attempted_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function pruneDelivered(olderThanDays = 7): void {
  const db = getSystemDatabase();
  db.prepare(
    "DELETE FROM webhook_outbox WHERE delivered = 1 AND delivered_at < datetime('now', ?)"
  ).run(`-${olderThanDays} days`);
}
