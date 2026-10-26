import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLaunchdPlist,
  buildSchtasksCommand,
  buildSystemdUnit,
  installDaemon,
} from '../src/setup/daemon.ts';

const opts = { targetDir: '/home/u/my-assistant', command: 'npx acp-connector start' };

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('buildSystemdUnit', () => {
  it('generates a valid user unit', () => {
    const unit = buildSystemdUnit(opts);
    expect(unit).toContain('[Service]');
    expect(unit).toContain(`WorkingDirectory=${opts.targetDir}`);
    expect(unit).toContain(`ExecStart=${opts.command}`);
    expect(unit).toContain('WantedBy=default.target');
  });
});

describe('buildLaunchdPlist', () => {
  it('generates a plist with argv, workdir and keepalive', () => {
    const plist = buildLaunchdPlist(opts);
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('com.assistant.acp-connector');
    expect(plist).toContain(`<string>${opts.targetDir}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    // argv split on spaces
    expect(plist).toContain('<string>npx</string>');
    expect(plist).toContain('<string>acp-connector</string>');
    expect(plist).toContain('<string>start</string>');
  });
});

describe('buildSchtasksCommand', () => {
  it('creates an ONLOGON task running the command in targetDir', () => {
    const cmd = buildSchtasksCommand({
      targetDir: 'C:\\Users\\u\\my-assistant',
      command: 'npx acp-connector start',
    });
    expect(cmd).toContain('schtasks /Create');
    expect(cmd).toContain('/SC ONLOGON');
    expect(cmd).toContain('/TN "Assistant"');
    expect(cmd).toContain('cd /d C:\\Users\\u\\my-assistant');
    expect(cmd).toContain('npx acp-connector start');
  });
});

describe('installDaemon', () => {
  it('linux: writes unit and runs systemctl --user commands', () => {
    tmp = mkdtempSync(join(tmpdir(), 'daemon-test-'));
    const home = join(tmp, 'home');
    writeFileSync(join(tmp, 'marker'), 'x'); // ensure tmp exists
    const cmds: string[] = [];
    const r = installDaemon('linux', opts, (c) => cmds.push(c), home);
    expect(r.mechanism).toBe('systemd --user');
    const unit = readFileSync(join(home, '.config/systemd/user/assistant.service'), 'utf8');
    expect(unit).toContain(`ExecStart=${opts.command}`);
    expect(cmds[0]).toBe('systemctl --user daemon-reload');
    expect(cmds[1]).toContain('systemctl --user enable --now assistant.service');
  });

  it('linux: still succeeds if loginctl fails', () => {
    tmp = mkdtempSync(join(tmpdir(), 'daemon-test-'));
    const home = join(tmp, 'home');
    const cmds: string[] = [];
    const r = installDaemon(
      'linux',
      opts,
      (c) => {
        cmds.push(c);
        if (c.startsWith('loginctl')) throw new Error('no loginctl');
      },
      home
    );
    expect(r.mechanism).toBe('systemd --user');
  });

  it('darwin: writes plist and loads it with launchctl', () => {
    tmp = mkdtempSync(join(tmpdir(), 'daemon-test-'));
    const home = join(tmp, 'home');
    const cmds: string[] = [];
    const r = installDaemon('darwin', opts, (c) => cmds.push(c), home);
    expect(r.mechanism).toBe('launchd');
    const plist = readFileSync(
      join(home, 'Library/LaunchAgents/com.assistant.acp-connector.plist'),
      'utf8'
    );
    expect(plist).toContain(`<string>${opts.targetDir}</string>`);
    expect(cmds.some((c) => c.startsWith('launchctl load -w'))).toBe(true);
  });

  it('win32: runs the schtasks command', () => {
    const cmds: string[] = [];
    const r = installDaemon('win32', opts, (c) => cmds.push(c));
    expect(r.mechanism).toBe('Task Scheduler');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('schtasks /Create');
  });

  it('throws on unsupported platforms', () => {
    expect(() => installDaemon('freebsd' as NodeJS.Platform, opts, () => {})).toThrow(
      /Unsupported platform/
    );
  });
});
