import { createHmac, randomUUID } from 'node:crypto';
import { BRIDGE_VERSION } from './acp-client.js';
import { log } from './logger.js';

/**
 * One configured webhook target. `events` is an allowlist:
 *   "*"          → every event
 *   "prefix.*"   → every event in that namespace (e.g. "prompt.*")
 *   "literal"    → exactly that event
 * `secret` enables an HMAC-SHA256 signature of the raw body in
 * `x-acp-signature` (format "sha256=<hex>", same scheme as GitHub).
 */
export interface WebhookEndpointConfig {
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
}

export interface WebhookPayload {
  /** Delivery id — unique per (endpoint, event) attempt. */
  id: string;
  /** Event name, namespaced: "prompt.completed", "agent.exited", … */
  event: string;
  /** ISO-8601 emission time. */
  at: string;
  bridge: { name: 'acp-connector'; version: string };
  sessionId?: string | null;
  platform?: string;
  chatId?: string | number;
  /** Prompt source when the event comes from the prompt pipeline. */
  source?: string;
  /** Event-specific fields. */
  data: Record<string, unknown>;
}

export type WebhookContext = Partial<
  Pick<WebhookPayload, 'sessionId' | 'platform' | 'chatId' | 'source'>
>;

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Fire-and-forget event fan-out to user-configured HTTP endpoints.
 * `emit()` never throws and never blocks the prompt queue — delivery
 * failures are logged and dropped (no retry: these are notifications,
 * not a delivery guarantee).
 */
export class WebhookEmitter {
  private endpoints: WebhookEndpointConfig[];
  private timeoutMs: number;
  private inFlight = new Set<Promise<void>>();

  constructor(endpoints: WebhookEndpointConfig[] | undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.endpoints = (endpoints ?? []).filter((e) => e?.url && Array.isArray(e.events));
    this.timeoutMs = timeoutMs;
  }

  get enabled(): boolean {
    return this.endpoints.length > 0;
  }

  /** Allowlist matching: "*" → all, "prefix.*" → namespace, literal → exact. */
  static matches(patterns: string[], event: string): boolean {
    for (const p of patterns) {
      if (p === '*') return true;
      if (p.endsWith('.*') && event.startsWith(p.slice(0, -1))) return true;
      if (p === event) return true;
    }
    return false;
  }

  /**
   * Emit one event to every subscribed endpoint. `context` carries
   * routing metadata (sessionId/platform/chatId/source); `data` is the
   * event-specific payload.
   */
  emit(event: string, data: Record<string, unknown> = {}, context: WebhookContext = {}): void {
    if (!this.enabled) return;
    for (const ep of this.endpoints) {
      if (!WebhookEmitter.matches(ep.events, event)) continue;
      const payload: WebhookPayload = {
        id: randomUUID(),
        event,
        at: new Date().toISOString(),
        bridge: { name: 'acp-connector', version: BRIDGE_VERSION },
        ...context,
        data,
      };
      const p = this._deliver(ep, payload).catch((err) => {
        log.warn(`webhook ${event} → ${ep.url} failed: ${(err as Error).message}`);
      });
      this.inFlight.add(p);
      p.finally(() => this.inFlight.delete(p));
    }
  }

  /**
   * Wait for in-flight deliveries (bounded by each delivery's timeout).
   * Used on shutdown so final events like `bridge.stopping` reach the wire.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private async _deliver(ep: WebhookEndpointConfig, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `acp-connector/${BRIDGE_VERSION}`,
      ...(ep.headers ?? {}),
      // Transport headers can't be overridden by user headers.
      'x-acp-event': payload.event,
      'x-acp-delivery': payload.id,
    };
    if (ep.secret) {
      headers['x-acp-signature'] =
        `sha256=${createHmac('sha256', ep.secret).update(body).digest('hex')}`;
    }
    const res = await fetch(ep.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  }
}
