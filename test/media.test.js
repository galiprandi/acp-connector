import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node-telegram-bot-api
const mockBot = {
  on: vi.fn(),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  editMessageText: vi.fn(async () => ({})),
  answerCallbackQuery: vi.fn(async () => ({})),
  stopPolling: vi.fn(),
  getFileLink: vi.fn(async () => 'https://example.com/file.jpg'),
};

vi.mock('node-telegram-bot-api', () => ({
  default: class MockTelegramBot {
    on = mockBot.on;
    sendMessage = mockBot.sendMessage;
    editMessageText = mockBot.editMessageText;
    answerCallbackQuery = mockBot.answerCallbackQuery;
    stopPolling = mockBot.stopPolling;
    getFileLink = mockBot.getFileLink;
  },
}));

// Mock fetch for downloads
const mockFetch = vi.fn(async () => ({
  arrayBuffer: async () => new TextEncoder().encode('fake-image-data').buffer,
}));
vi.stubGlobal('fetch', mockFetch);

function createMockAcp() {
  const updates = [];
  return {
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => {
      if (updates.length > 0) return updates.shift();
      return { kind: 'stop', stopReason: 'end_turn' };
    }),
    _pushUpdate: (update) => updates.push(update),
    _updates: updates,
    promptCapabilities: { image: true },
  };
}

const { MediaHandler } = await import('../src/media.ts');
const { BridgeBot } = await import('../src/bot.js');

const TEST_UPLOADS_DIR = '/tmp/test-acp-connector-uploads';

function createBot(opts = {}) {
  const acp = createMockAcp();
  const mediaHandler = new MediaHandler({
    uploadsDir: TEST_UPLOADS_DIR,
    supportsImage: true,
  });
  const bot = new BridgeBot({
    acp,
    telegramToken: 'test-token',
    allowedChatIds: [123],
    agentCmd: 'acp-agent serve',
    mediaHandler,
    ...opts,
  });
  return { bot, acp, mediaHandler };
}

describe('MediaHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
    } catch {}
    try {
      mkdirSync(TEST_UPLOADS_DIR, { recursive: true });
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('saves file to disk', () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: true });
    const data = Buffer.from('fake-image');
    const file = handler.saveFile(data, 'image/jpeg', 'jpg');
    expect(existsSync(file.path)).toBe(true);
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.data).toBe(data.toString('base64'));
  });

  it('creates ImageContent when agent supports image', () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: true });
    const data = Buffer.from('fake-image');
    const file = handler.saveFile(data, 'image/jpeg', 'jpg');
    const blocks = handler.toContentBlocks(file);
    expect(blocks[0].type).toBe('image');
  });

  it('creates ResourceLink when agent does not support image', () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: false });
    const data = Buffer.from('fake-image');
    const file = handler.saveFile(data, 'image/jpeg', 'jpg');
    const blocks = handler.toContentBlocks(file);
    expect(blocks[0].type).toBe('resource_link');
  });

  it('creates ResourceLink for non-image files', () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: true });
    const data = Buffer.from('fake-pdf');
    const file = handler.saveFile(data, 'application/pdf', 'pdf');
    const blocks = handler.toContentBlocks(file);
    expect(blocks[0].type).toBe('resource_link');
  });

  it('adds caption as text block', () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: true });
    const data = Buffer.from('fake-image');
    const file = handler.saveFile(data, 'image/jpeg', 'jpg');
    const blocks = handler.toContentBlocks(file, 'look at this');
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe('text');
  });

  it('processMedia downloads, saves, and converts', async () => {
    const handler = new MediaHandler({ uploadsDir: TEST_UPLOADS_DIR, supportsImage: true });
    const downloadFn = async () => Buffer.from('downloaded-data');
    const blocks = await handler.processMedia(downloadFn, 'image/png', 'png', 'caption');
    expect(blocks[0].type).toBe('image');
    expect(blocks[1].type).toBe('text');
  });

  it('creates uploads dir if it does not exist', () => {
    const dir = join(TEST_UPLOADS_DIR, 'subdir');
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    new MediaHandler({ uploadsDir: dir, supportsImage: false });
    expect(existsSync(dir)).toBe(true);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
});

describe('BridgeBot media handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
    } catch {}
    try {
      mkdirSync(TEST_UPLOADS_DIR, { recursive: true });
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('downloads and processes photo messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({
      chat: { id: 123 },
      photo: [{ file_id: 'photo1', file_unique_id: 'u1' }],
      caption: 'check this out',
    });
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(Array.isArray(promptArg)).toBe(true);
    // Should have image block + text caption
    expect(promptArg[0].type).toBe('image');
    expect(promptArg[1].type).toBe('text');
  });

  it('downloads and processes document messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({
      chat: { id: 123 },
      document: { file_id: 'doc1', file_name: 'report.pdf', mime_type: 'application/pdf' },
    });
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(Array.isArray(promptArg)).toBe(true);
    expect(promptArg[0].type).toBe('resource_link');
  });

  it('falls back to ResourceLink when agent does not support image', async () => {
    const acp = createMockAcp();
    acp.promptCapabilities = { image: false };
    const mediaHandler = new MediaHandler({
      uploadsDir: TEST_UPLOADS_DIR,
      supportsImage: false,
    });
    const bot = new BridgeBot({
      acp,
      telegramToken: 'test-token',
      allowedChatIds: [123],
      agentCmd: 'acp-agent serve',
      mediaHandler,
    });
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({
      chat: { id: 123 },
      photo: [{ file_id: 'photo1', file_unique_id: 'u1' }],
    });
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(Array.isArray(promptArg)).toBe(true);
    expect(promptArg[0].type).toBe('resource_link');
  });

  it('sends error message on download failure', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    mockBot.getFileLink.mockRejectedValueOnce(new Error('network error'));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({
      chat: { id: 123 },
      photo: [{ file_id: 'photo1', file_unique_id: 'u1' }],
    });
    await vi.waitFor(() => {
      expect(mockBot.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining('Error downloading media')
      );
    });
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('rejects media when no mediaHandler configured', async () => {
    const acp = createMockAcp();
    const bot = new BridgeBot({
      acp,
      telegramToken: 'test-token',
      allowedChatIds: [123],
      agentCmd: 'acp-agent serve',
    });
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({
      chat: { id: 123 },
      photo: [{ file_id: 'photo1', file_unique_id: 'u1' }],
    });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Media no soportado');
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('handles sticker messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({
      chat: { id: 123 },
      sticker: { file_id: 'sticker1' },
    });
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(promptArg[0].type).toBe('image'); // webp is image
  });
});
