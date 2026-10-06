import { describe, expect, it, vi } from 'vitest';
import { LoopbackBot } from '../src/loopback.ts';

function makeAcp(chunks: string[] = ['hello']) {
  const updates = chunks.map((text) => ({
    kind: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  }));
  updates.push({ kind: 'stop' });
  return {
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => updates.shift() ?? { kind: 'stop' }),
  };
}

describe('LoopbackBot', () => {
  it('processes a prompt and resolves onComplete with the response', async () => {
    const acp = makeAcp(['hello ', 'world']);
    const bot = new LoopbackBot(acp as never);
    const done = vi.fn();
    await bot.enqueuePrompt('task', undefined, undefined, done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith('hello world', undefined));
    expect(acp.prompt).toHaveBeenCalledWith('task');
  });

  it('serializes prompts — second waits for the first', async () => {
    const order: string[] = [];
    const acp = {
      prompt: vi.fn(async (t: string) => {
        order.push(`start:${t}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${t}`);
      }),
      nextUpdate: vi.fn(async () => ({ kind: 'stop' })),
    };
    const bot = new LoopbackBot(acp as never);
    await bot.enqueuePrompt('first');
    await bot.enqueuePrompt('second');
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('resolves onComplete with the error when the agent fails', async () => {
    const acp = {
      prompt: vi.fn(async () => {
        throw new Error('agent down');
      }),
      nextUpdate: vi.fn(),
    };
    const bot = new LoopbackBot(acp as never);
    const done = vi.fn();
    await bot.enqueuePrompt('task', undefined, undefined, done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith('', 'agent down'));
  });

  it('runs commands for operator sources (http/cron/routine) but never for a2a content', async () => {
    const acp = makeAcp();
    const bot = new LoopbackBot(acp as never);
    const onCommand = vi.fn(async () => true);
    bot.setCommandHandler(onCommand);

    await bot.enqueuePrompt('/a2a status', undefined, undefined, undefined, 'http');
    expect(onCommand).toHaveBeenCalled();

    onCommand.mockClear();
    acp.prompt.mockClear();
    await bot.enqueuePrompt('/a2a approve evil', undefined, undefined, undefined, 'a2a');
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalledWith('/a2a approve evil'));
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('auto-approves the first allow* permission option', () => {
    const bot = new LoopbackBot(makeAcp() as never);
    const res = bot._handlePermission({
      options: [
        { kind: 'reject_once', optionId: 'r1' },
        { kind: 'allow_once', optionId: 'a1' },
      ],
    });
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'a1' } });
  });

  it('cancels when no allow option exists', () => {
    const bot = new LoopbackBot(makeAcp() as never);
    const res = bot._handlePermission({ options: [{ kind: 'reject_always', optionId: 'r' }] });
    expect(res).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
