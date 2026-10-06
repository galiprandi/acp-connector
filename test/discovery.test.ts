import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A2aConfig } from '../src/config.ts';
import { DiscoveryService, type InstanceRecord, type MdnsAdvertiser } from '../src/discovery.ts';
import { NetworkStore } from '../src/network.ts';

let dir: string;
let instancesFile: string;
let network: NetworkStore;

const SELF_ID = 'self-agent';
const SELF_CARD_URL = 'http://localhost:7741';

function makeService(config: A2aConfig = {}, mdns?: MdnsAdvertiser): DiscoveryService {
  return new DiscoveryService({
    config,
    network,
    selfId: SELF_ID,
    selfCardUrl: SELF_CARD_URL,
    instancesFile,
    mdns,
  });
}

function readInstances(): InstanceRecord[] {
  return JSON.parse(readFileSync(instancesFile, 'utf8'));
}

function writeInstances(instances: InstanceRecord[]): void {
  writeFileSync(instancesFile, JSON.stringify(instances), 'utf8');
}

function makeInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: 'other-agent',
    cardUrl: 'http://localhost:8000/other',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    role: 'peer',
    ...overrides,
  };
}

class FakeMdns implements MdnsAdvertiser {
  announced: { name: string; port: number; txt: Record<string, string> }[] = [];
  stopped = false;
  services: { name: string; host: string; port: number; txt: Record<string, string> }[] = [];

  announce(service: { name: string; port: number; txt: Record<string, string> }): void {
    this.announced.push(service);
  }

  async *browse(): AsyncIterable<{
    name: string;
    host: string;
    port: number;
    txt: Record<string, string>;
  }> {
    for (const s of this.services) yield s;
  }

  stop(): void {
    this.stopped = true;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-disc-'));
  instancesFile = join(dir, 'instances.json');
  network = new NetworkStore(join(dir, 'network.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('shared-file strategy', () => {
  it('registers itself on start and deregisters on stop', async () => {
    const svc = makeService();
    await svc.start();
    const instances = readInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe(SELF_ID);
    expect(instances[0].cardUrl).toBe(SELF_CARD_URL);
    expect(instances[0].pid).toBe(process.pid);

    await svc.stop();
    expect(readInstances()).toHaveLength(0);
  });

  it('discovers other live instances', async () => {
    writeInstances([makeInstance()]);
    const svc = makeService();
    const peers = await svc.discover();
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      id: 'other-agent',
      cardUrl: 'http://localhost:8000/other',
      source: 'shared-file',
    });
  });

  it('skips stale entries with dead pids', async () => {
    writeInstances([makeInstance({ id: 'dead-agent', pid: 999999 }), makeInstance({ id: 'live' })]);
    const svc = makeService();
    const peers = await svc.discover();
    expect(peers.map((p) => p.id)).toEqual(['live']);
  });

  it('never returns self', async () => {
    const svc = makeService();
    await svc.start();
    writeInstances([...readInstances(), makeInstance()]);
    const peers = await svc.discover();
    expect(peers.map((p) => p.id)).not.toContain(SELF_ID);
    await svc.stop();
  });

  it('returns an empty list when the instances file is missing or corrupt', async () => {
    expect(await makeService().discover()).toEqual([]);
    writeFileSync(instancesFile, 'not-json{{{');
    expect(await makeService().discover()).toEqual([]);
  });
});

describe('static strategy', () => {
  it('returns the registry URL and trusted peers as declared peers', async () => {
    const svc = makeService({
      registry: 'https://registry.example.com',
      trustedPeers: ['http://peer-a:9000', 'http://peer-b:9001'],
    });
    const peers = await svc.discover();
    const statics = peers.filter((p) => p.source === 'static');
    expect(statics.map((p) => p.cardUrl)).toEqual([
      'https://registry.example.com',
      'http://peer-a:9000',
      'http://peer-b:9001',
    ]);
  });

  it('upserts discovered peers into the network store', async () => {
    const svc = makeService({ registry: 'https://registry.example.com' });
    await svc.discover();
    const stored = network.getPeer('registry');
    expect(stored?.source).toBe('declared');
    expect(stored?.status).toBe('pending');
  });
});

describe('registry role detection', () => {
  it('findExistingRegistry returns a registry-role instance cardUrl', async () => {
    writeInstances([makeInstance({ role: 'registry', cardUrl: 'http://localhost:8000/reg' })]);
    expect(await makeService().findExistingRegistry()).toBe('http://localhost:8000/reg');
  });

  it('findExistingRegistry returns null when no registry instance exists', async () => {
    writeInstances([makeInstance({ role: 'peer' })]);
    expect(await makeService().findExistingRegistry()).toBeNull();
  });

  it('findExistingRegistry ignores dead registry instances', async () => {
    writeInstances([makeInstance({ role: 'registry', pid: 999999 })]);
    expect(await makeService().findExistingRegistry()).toBeNull();
  });
});

describe('mDNS strategy', () => {
  it('announces itself on start and stops on stop', async () => {
    const fake = new FakeMdns();
    const svc = makeService({ port: 7741 }, fake);
    await svc.start();
    expect(fake.announced).toHaveLength(1);
    expect(fake.announced[0].name).toBe(SELF_ID);
    expect(fake.announced[0].txt.cardUrl).toBe(SELF_CARD_URL);

    await svc.stop();
    expect(fake.stopped).toBe(true);
  });

  it('merges mDNS peers into discover results', async () => {
    const fake = new FakeMdns();
    fake.services.push(
      {
        name: 'lan-agent',
        host: '192.168.1.10',
        port: 7741,
        txt: { id: 'lan-agent', cardUrl: 'http://192.168.1.10:7741' },
      },
      { name: SELF_ID, host: '127.0.0.1', port: 7741, txt: { id: SELF_ID, cardUrl: SELF_CARD_URL } }
    );
    const svc = makeService({}, fake);
    await svc.start();
    const peers = await svc.discover();
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      id: 'lan-agent',
      cardUrl: 'http://192.168.1.10:7741',
      source: 'mdns',
    });
    await svc.stop();
  });

  it('dedupes peers seen by multiple strategies', async () => {
    writeInstances([makeInstance()]);
    const fake = new FakeMdns();
    fake.services.push({
      name: 'other-agent',
      host: '192.168.1.20',
      port: 8000,
      txt: { id: 'other-agent', cardUrl: 'http://localhost:8000/other' },
    });
    const svc = makeService({}, fake);
    const peers = await svc.discover();
    expect(peers).toHaveLength(1);
    expect(peers[0].source).toBe('shared-file');
  });
});
