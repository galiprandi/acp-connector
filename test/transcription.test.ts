import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpClient } from '../src/acp-client';
import type { Transcriber } from '../src/transcriber';

type MockFn = ReturnType<typeof vi.fn>;

interface MockBot {
  on: MockFn;
  sendMessage: MockFn;
  editMessageText: MockFn;
  answerCallbackQuery: MockFn;
  stopPolling: MockFn;
  getFileLink: MockFn;
  setMessageReaction: MockFn;
}

const mockBot: MockBot = {
  on: vi.fn(),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  editMessageText: vi.fn(async () => ({})),
  answerCallbackQuery: vi.fn(async () => ({})),
  stopPolling: vi.fn(),
  getFileLink: vi.fn(async () => 'https://example.com/voice.ogg'),
  setMessageReaction: vi.fn(async () => ({})),
};

vi.mock('node-telegram-bot-api', () => ({
  default: class MockTelegramBot {
    on = mockBot.on;
    sendMessage = mockBot.sendMessage;
    editMessageText = mockBot.editMessageText;
    answerCallbackQuery = mockBot.answerCallbackQuery;
    stopPolling = mockBot.stopPolling;
    getFileLink = mockBot.getFileLink;
    setMessageReaction = mockBot.setMessageReaction;
  },
}));

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => new TextEncoder().encode('fake-ogg-data').buffer,
  }))
);

function createMockAcp() {
  const updates: unknown[] = [];
  return {
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => {
      if (updates.length > 0) return updates.shift();
      return { kind: 'stop', stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => {}),
    promptCapabilities: { image: true },
  };
}

const { MediaHandler } = await import('../src/media.ts');
const { BridgeBot } = await import('../src/bot.js');
const { createTranscriber, transcriptionEnabled, deleteAfterTranscribe } = await import(
  '../src/transcriber.ts'
);

const TEST_UPLOADS_DIR = '/tmp/test-acp-transcription-uploads';
const savedFiles = () => (existsSync(TEST_UPLOADS_DIR) ? readdirSync(TEST_UPLOADS_DIR) : []);

type BotOverrides = Partial<ConstructorParameters<typeof BridgeBot>[0]>;

function createBot(transcriber: Transcriber | null, opts: BotOverrides = {}) {
  const acp = createMockAcp();
  const mediaHandler = new MediaHandler({
    uploadsDir: TEST_UPLOADS_DIR,
    supportsImage: true,
    transcriber,
    deleteAfterTranscribe: true,
  });
  const bot = new BridgeBot({
    acp: acp as unknown as AcpClient,
    telegramToken: 'test-token',
    allowedChatIds: [123],
    agentCmd: 'acp-agent serve',
    mediaHandler,
    ...opts,
  });
  return { bot, acp, mediaHandler };
}

const voiceMsg = {
  chat: { id: 123 },
  message_id: 42,
  voice: { file_id: 'voice1', mime_type: 'audio/ogg', duration: 10 },
  caption: 'dime algo',
};

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
  mkdirSync(TEST_UPLOADS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
});

describe('MediaHandler.processVoiceNote', () => {
  it('returns a text block with the transcript and deletes the file', async () => {
    const transcriber: Transcriber = { transcribe: vi.fn(async () => 'hola mundo') };
    const handler = new MediaHandler({
      uploadsDir: TEST_UPLOADS_DIR,
      supportsImage: true,
      transcriber,
      deleteAfterTranscribe: true,
    });
    const blocks = await handler.processVoiceNote(
      async () => Buffer.from('ogg'),
      'audio/ogg',
      'ogg'
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'hola mundo' });
    expect(savedFiles()).toHaveLength(0);
    expect(handler.canTranscribe).toBe(true);
  });

  it('keeps the file when deleteAfterTranscribe is false', async () => {
    const transcriber: Transcriber = { transcribe: vi.fn(async () => 'hola') };
    const handler = new MediaHandler({
      uploadsDir: TEST_UPLOADS_DIR,
      supportsImage: true,
      transcriber,
      deleteAfterTranscribe: false,
    });
    await handler.processVoiceNote(async () => Buffer.from('ogg'), 'audio/ogg', 'ogg');
    expect(savedFiles()).toHaveLength(1);
  });

  it('deletes the file and rethrows when transcription fails', async () => {
    const transcriber: Transcriber = {
      transcribe: vi.fn(async () => {
        throw new Error('whisper exploded');
      }),
    };
    const handler = new MediaHandler({
      uploadsDir: TEST_UPLOADS_DIR,
      supportsImage: true,
      transcriber,
      deleteAfterTranscribe: false, // even with keep-on-success, failure deletes
    });
    await expect(
      handler.processVoiceNote(async () => Buffer.from('ogg'), 'audio/ogg', 'ogg')
    ).rejects.toThrow('whisper exploded');
    expect(savedFiles()).toHaveLength(0);
  });

  it('treats an empty transcript as failure and deletes the file', async () => {
    const transcriber: Transcriber = { transcribe: vi.fn(async () => '   ') };
    const handler = new MediaHandler({
      uploadsDir: TEST_UPLOADS_DIR,
      supportsImage: true,
      transcriber,
    });
    await expect(
      handler.processVoiceNote(async () => Buffer.from('ogg'), 'audio/ogg', 'ogg')
    ).rejects.toThrow('empty');
    expect(savedFiles()).toHaveLength(0);
  });

  it('canTranscribe is false without a transcriber', () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: true });
    expect(handler.canTranscribe).toBe(false);
  });
});

describe('transcriber config helpers', () => {
  it('defaults enabled and deleteAfterTranscribe to true', () => {
    expect(transcriptionEnabled(undefined)).toBe(true);
    expect(transcriptionEnabled({})).toBe(true);
    expect(transcriptionEnabled({ enabled: false })).toBe(false);
    expect(deleteAfterTranscribe(undefined)).toBe(true);
    expect(deleteAfterTranscribe({ deleteAfterTranscribe: false })).toBe(false);
  });

  it('createTranscriber returns null when disabled', () => {
    expect(createTranscriber({ enabled: false })).toBeNull();
    expect(createTranscriber(undefined)).not.toBeNull();
  });
});

describe('BridgeBot voice note handling', () => {
  it('transcribes a voice message into a text block for the agent', async () => {
    const transcriber: Transcriber = { transcribe: vi.fn(async () => 'el transcript del audio') };
    const { bot, acp } = createBot(transcriber);
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler(voiceMsg);
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(promptArg[0]).toMatchObject({ type: 'text', text: 'el transcript del audio' });
    // caption rides along as a second text block
    expect(promptArg[1]).toMatchObject({ type: 'text', text: 'dime algo' });
    // 🎧-equivalent reaction lifecycle (👀 on Telegram)
    expect(mockBot.setMessageReaction).toHaveBeenCalled();
    expect(savedFiles()).toHaveLength(0);
  });

  it('keeps legacy resource_link path when transcription is disabled', async () => {
    const { bot, acp } = createBot(null);
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler(voiceMsg);
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(promptArg[0].type).toBe('resource_link');
  });

  it('notifies the user and enqueues nothing when transcription fails', async () => {
    const transcriber: Transcriber = {
      transcribe: vi.fn(async () => {
        throw new Error('model missing');
      }),
    };
    const { bot, acp } = createBot(transcriber);
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler(voiceMsg);
    await vi.waitFor(() =>
      expect(mockBot.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining('Transcription failed')
      )
    );
    expect(acp.prompt).not.toHaveBeenCalled();
    expect(savedFiles()).toHaveLength(0);
  });
});
