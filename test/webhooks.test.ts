import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/logger.js';
import { WebhookEmitter, type WebhookPayload } from '../src/webhooks.js';

const URL_A = 'https://hooks.example.com/a';
const URL_B = 'https://hooks.example.com/b';

function lastCallBody(): WebhookPayload {
  const calls = vi.mocked(fetch).mock.calls;
  return JSON.parse(calls[calls.length - 1][1]?.body as string);
}

describe('WebhookEmitter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('event matching', () => {
    it('"*" matches every event', () => {
      expect(WebhookEmitter.matches(['*'], 'prompt.received')).toBe(true);
      expect(WebhookEmitter.matches(['*'], 'anything.else')).toBe(true);
    });

    it('"prefix.*" matches the namespace only', () => {
      expect(WebhookEmitter.matches(['prompt.*'], 'prompt.completed')).toBe(true);
      expect(WebhookEmitter.matches(['prompt.*'], 'job.fired')).toBe(false);
      expect(WebhookEmitter.matches(['prompt.*'], 'promptx.received')).toBe(false);
    });

    it('literal matches exactly', () => {
      expect(WebhookEmitter.matches(['agent.exited'], 'agent.exited')).toBe(true);
      expect(WebhookEmitter.matches(['agent.exited'], 'agent.exited.now')).toBe(false);
    });

    it('combines patterns across the list', () => {
      const events = ['job.fired', 'permission.*'];
      expect(WebhookEmitter.matches(events, 'job.fired')).toBe(true);
      expect(WebhookEmitter.matches(events, 'permission.request')).toBe(true);
      expect(WebhookEmitter.matches(events, 'prompt.completed')).toBe(false);
    });
  });

  describe('emit', () => {
    it('posts the event payload to subscribed endpoints', async () => {
      const emitter = new WebhookEmitter([
        { url: URL_A, events: ['prompt.*'] },
        { url: URL_B, events: ['job.*'] },
      ]);
      emitter.emit('prompt.completed', { response: 'done' }, { sessionId: 's1', chatId: 42 });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe(URL_A);
      const body = lastCallBody();
      expect(body.event).toBe('prompt.completed');
      expect(body.data).toEqual({ response: 'done' });
      expect(body.sessionId).toBe('s1');
      expect(body.chatId).toBe(42);
      expect(body.bridge.name).toBe('acp-connector');
      expect(body.id).toBeTruthy();
      expect(body.at).toBeTruthy();
      expect(init?.method).toBe('POST');
    });

    it('fans out to multiple subscribed endpoints', async () => {
      const emitter = new WebhookEmitter([
        { url: URL_A, events: ['*'] },
        { url: URL_B, events: ['agent.*'] },
      ]);
      emitter.emit('agent.exited', { code: 0 });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const urls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
      expect(urls).toEqual([URL_A, URL_B]);
    });

    it('includes the transport headers', async () => {
      const emitter = new WebhookEmitter([{ url: URL_A, events: ['*'] }]);
      emitter.emit('bridge.started', {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-acp-event']).toBe('bridge.started');
      expect(headers['x-acp-delivery']).toBeTruthy();
    });

    it('signs the body with x-acp-signature when secret is set', async () => {
      const emitter = new WebhookEmitter([{ url: URL_A, events: ['*'], secret: 's3cr3t' }]);
      emitter.emit('job.fired', { id: 'j1' });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const init = vi.mocked(fetch).mock.calls[0][1];
      const headers = init?.headers as Record<string, string>;
      const expected = `sha256=${createHmac('sha256', 's3cr3t')
        .update(init?.body as string)
        .digest('hex')}`;
      expect(headers['x-acp-signature']).toBe(expected);
    });

    it('omits the signature header without a secret', async () => {
      const emitter = new WebhookEmitter([{ url: URL_A, events: ['*'] }]);
      emitter.emit('job.fired', {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['x-acp-signature']).toBeUndefined();
    });

    it('merges custom headers without overriding transport ones', async () => {
      const emitter = new WebhookEmitter([
        {
          url: URL_A,
          events: ['*'],
          headers: { 'x-custom': 'yes', 'x-acp-event': 'forged' },
        },
      ]);
      emitter.emit('prompt.received', {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['x-custom']).toBe('yes');
      expect(headers['x-acp-event']).toBe('prompt.received');
    });

    it('does not throw on delivery failure — logs a warning', async () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      vi.mocked(fetch).mockRejectedValueOnce(new Error('conn refused'));
      const emitter = new WebhookEmitter([{ url: URL_A, events: ['*'] }]);
      expect(() => emitter.emit('agent.exited', {})).not.toThrow();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(warn.mock.calls[0][0]).toContain('agent.exited');
    });

    it('warns on non-2xx responses', async () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 500 }));
      const emitter = new WebhookEmitter([{ url: URL_A, events: ['*'] }]);
      emitter.emit('job.failed', {});
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(warn.mock.calls[0][0]).toContain('HTTP 500');
    });

    it('does nothing with no endpoints configured', () => {
      const emitter = new WebhookEmitter(undefined);
      expect(emitter.enabled).toBe(false);
      emitter.emit('prompt.received', {});
      expect(fetch).not.toHaveBeenCalled();
    });

    it('skips malformed endpoint entries', async () => {
      const emitter = new WebhookEmitter([
        { url: '', events: ['*'] },
        { url: URL_A } as never,
        { url: URL_B, events: ['*'] },
      ]);
      emitter.emit('prompt.received', {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(URL_B);
    });
  });
});
