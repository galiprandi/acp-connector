import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { A2aConfig } from './config.js';
import { log } from './logger.js';
import type { NetworkStore } from './network.js';

export const DEFAULT_INSTANCES_FILE = join(homedir(), '.acp-connector', 'instances.json');
export const MDNS_SERVICE_TYPE = '_a2a._tcp';

/**
 * A peer found by a discovery strategy, before any trust decision.
 */
export interface DiscoveredPeer {
  id: string;
  cardUrl: string;
  source: 'shared-file' | 'mdns' | 'static';
}

/**
 * One entry in the shared instances registry file.
 */
export interface InstanceRecord {
  id: string;
  cardUrl: string;
  pid: number;
  startedAt: string;
  role?: 'peer' | 'registry';
}

/**
 * Injectable mDNS advertiser/browser. The real implementation is a lazy
 * dynamic import of `bonjour-service`; tests inject a fake.
 */
export interface MdnsAdvertiser {
  announce(service: { name: string; port: number; txt: Record<string, string> }): void;
  browse(
    serviceType: string
  ): AsyncIterable<{ name: string; host: string; port: number; txt: Record<string, string> }>;
  stop(): void;
}

/**
 * Options for constructing a {@link DiscoveryService}.
 */
export interface DiscoveryServiceOptions {
  /** The `a2a` section of the bridge config. */
  config: A2aConfig;
  /** Network state store — discovered peers are upserted into it. */
  network: NetworkStore;
  /** This instance's stable agent id. */
  selfId: string;
  /** This instance's agent-card base URL. */
  selfCardUrl: string;
  /** Override for the instances registry file (tests). */
  instancesFile?: string;
  /** Injected mDNS implementation (tests). When omitted, a lazy import of `bonjour-service` is attempted. */
  mdns?: MdnsAdvertiser;
}

/**
 * True when `pid` refers to a live process. `EPERM` means the process exists
 * but is owned by another user — still alive for our purposes.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Pluggable peer discovery for the A2A agent network. Three strategies,
 * all resolving to peer card URLs:
 *
 * - **shared-file**: a local instances registry (`~/.acp-connector/instances.json`)
 *   for same-host discovery; stale entries (dead pids) are skipped.
 * - **mdns**: LAN announce/browse via an injectable {@link MdnsAdvertiser};
 *   the `bonjour-service` backend is optional and non-fatal when missing.
 * - **static**: `config.registry` and `config.trustedPeers` from config.
 */
export class DiscoveryService {
  private readonly instancesFile: string;
  private mdns: MdnsAdvertiser | null;
  private readonly mdnsInjected: boolean;

  constructor(private opts: DiscoveryServiceOptions) {
    this.instancesFile = opts.instancesFile ?? DEFAULT_INSTANCES_FILE;
    this.mdns = opts.mdns ?? null;
    this.mdnsInjected = Boolean(opts.mdns);
  }

  /**
   * Register this instance in the shared file and start mDNS announce.
   */
  async start(): Promise<void> {
    this.registerSelf();
    await this.ensureMdns();
    if (this.mdns) {
      try {
        this.mdns.announce({
          name: this.opts.selfId,
          port: this.opts.config.port ?? 7741,
          txt: {
            id: this.opts.selfId,
            cardUrl: this.opts.selfCardUrl,
            role: this.opts.config.registryMode ? 'registry' : 'peer',
          },
        });
      } catch (err) {
        log.warn(`mDNS announce failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Deregister this instance and stop mDNS.
   */
  async stop(): Promise<void> {
    this.deregisterSelf();
    if (this.mdns) {
      try {
        this.mdns.stop();
      } catch {
        // non-fatal
      }
    }
  }

  /**
   * Run all strategies and return the union of discovered peers.
   * Never returns this instance. Results are upserted into the
   * {@link NetworkStore} as `pending` peers.
   */
  async discover(): Promise<DiscoveredPeer[]> {
    const peers: DiscoveredPeer[] = [];
    const seen = new Set<string>([this.opts.selfId, this.opts.selfCardUrl]);

    const push = (peer: DiscoveredPeer) => {
      if (seen.has(peer.id) || seen.has(peer.cardUrl)) return;
      seen.add(peer.id);
      seen.add(peer.cardUrl);
      peers.push(peer);
    };

    for (const inst of this.readInstances()) {
      if (inst.id === this.opts.selfId || inst.cardUrl === this.opts.selfCardUrl) continue;
      if (!isPidAlive(inst.pid)) continue;
      push({ id: inst.id, cardUrl: inst.cardUrl, source: 'shared-file' });
    }

    if (this.mdns) {
      try {
        for await (const svc of this.mdns.browse(MDNS_SERVICE_TYPE)) {
          const id = svc.txt?.id ?? svc.name;
          const cardUrl = svc.txt?.cardUrl ?? `http://${svc.host}:${svc.port}`;
          if (id === this.opts.selfId || cardUrl === this.opts.selfCardUrl) continue;
          push({ id, cardUrl, source: 'mdns' });
        }
      } catch (err) {
        log.warn(`mDNS browse failed: ${(err as Error).message}`);
      }
    }

    if (this.opts.config.registry) {
      push({ id: 'registry', cardUrl: this.opts.config.registry, source: 'static' });
    }
    for (const trusted of this.opts.config.trustedPeers ?? []) {
      push({ id: trusted, cardUrl: trusted, source: 'static' });
    }

    for (const peer of peers) {
      this.opts.network.upsertPeer({
        id: peer.id,
        cardUrl: peer.cardUrl,
        status: 'pending',
        source: peer.source === 'static' ? 'declared' : 'discovered',
        lastSeen: new Date().toISOString(),
      });
    }
    this.opts.network.save();

    return peers;
  }

  /**
   * Returns the cardUrl of a discovered peer that advertises the registry
   * role, or `null`. Used for first-wins registry collision handling.
   */
  async findExistingRegistry(): Promise<string | null> {
    for (const inst of this.readInstances()) {
      if (inst.id === this.opts.selfId) continue;
      if (inst.role !== 'registry') continue;
      if (!isPidAlive(inst.pid)) continue;
      return inst.cardUrl;
    }
    return null;
  }

  private readInstances(): InstanceRecord[] {
    if (!existsSync(this.instancesFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.instancesFile, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as InstanceRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeInstances(instances: InstanceRecord[]): void {
    mkdirSync(dirname(this.instancesFile), { recursive: true });
    writeFileSync(this.instancesFile, `${JSON.stringify(instances, null, 2)}\n`, 'utf8');
  }

  private registerSelf(): void {
    const instances = this.readInstances().filter((i) => i.id !== this.opts.selfId);
    instances.push({
      id: this.opts.selfId,
      cardUrl: this.opts.selfCardUrl,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      role: this.opts.config.registryMode ? 'registry' : 'peer',
    });
    this.writeInstances(instances);
  }

  private deregisterSelf(): void {
    const instances = this.readInstances().filter((i) => i.id !== this.opts.selfId);
    this.writeInstances(instances);
  }

  /**
   * When no advertiser was injected, try to load `bonjour-service`.
   * The dependency is optional — a failed import just disables mDNS.
   */
  private async ensureMdns(): Promise<void> {
    if (this.mdnsInjected) return;
    try {
      // Non-literal specifier: the dependency is optional, so tsc must not
      // require its types at compile time.
      const specifier = 'bonjour-service';
      const mod = (await import(specifier)) as Record<string, unknown>;
      const Bonjour = (mod.default ?? mod.Bonjour ?? mod) as new () => {
        publish(opts: {
          name: string;
          type: string;
          port: number;
          txt: Record<string, string>;
        }): void;
        find(opts: { type: string }): {
          on(ev: string, fn: (s: unknown) => void): void;
          stop(): void;
        };
        destroy(): void;
      };
      const bonjour = new Bonjour();
      this.mdns = {
        announce: (service) =>
          bonjour.publish({
            name: service.name,
            type: MDNS_SERVICE_TYPE,
            port: service.port,
            txt: service.txt,
          }),
        browse: (serviceType) => this.browseIterable(bonjour, serviceType),
        stop: () => bonjour.destroy(),
      };
    } catch {
      log.warn(
        'mDNS discovery unavailable: optional dependency "bonjour-service" is not installed'
      );
    }
  }

  private async *browseIterable(
    bonjour: {
      find(opts: { type: string }): {
        on(ev: string, fn: (s: unknown) => void): void;
        stop(): void;
      };
    },
    serviceType: string
  ): AsyncIterable<{ name: string; host: string; port: number; txt: Record<string, string> }> {
    const queue: { name: string; host: string; port: number; txt: Record<string, string> }[] = [];
    let resolveWait: (() => void) | null = null;
    const browser = bonjour.find({ type: serviceType });
    browser.on('up', (s) => {
      const svc = s as { name: string; host?: string; port: number; txt?: Record<string, string> };
      queue.push({
        name: svc.name,
        host: svc.host ?? 'localhost',
        port: svc.port,
        txt: svc.txt ?? {},
      });
      resolveWait?.();
    });
    // A short snapshot window — mDNS is a continuous protocol, but discovery
    // callers want a bounded result set.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (queue.length > 0) {
        yield queue.shift() as {
          name: string;
          host: string;
          port: number;
          txt: Record<string, string>;
        };
        continue;
      }
      await new Promise<void>((r) => {
        resolveWait = r;
        setTimeout(r, Math.max(1, deadline - Date.now()));
      });
      if (queue.length === 0) break;
    }
    browser.stop();
  }
}
