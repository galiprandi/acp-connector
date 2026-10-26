import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Native autostart installers for the assistant-setup wizard.
 *
 * The unit/plist/command builders are pure string functions so they can be
 * unit-tested without touching the system. `installDaemon` is the only part
 * that writes files or shells out — it runs ONLY on explicit user opt-in.
 */

export interface DaemonOptions {
  /** Working directory of the installed assistant (the template clone). */
  targetDir: string;
  /** Command the daemon should run (e.g. "devin acp" via acp-connector). */
  command: string;
}

const SERVICE_NAME = 'assistant';

/** systemd --user unit (Linux). */
export function buildSystemdUnit(opts: DaemonOptions): string {
  return `[Unit]
Description=Personal AI assistant (acp-connector)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.targetDir}
ExecStart=${opts.command}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** launchd plist (macOS). Installed under ~/Library/LaunchAgents. */
export function buildLaunchdPlist(opts: DaemonOptions): string {
  const [bin, ...args] = opts.command.split(' ');
  const argv = [bin, ...args].map((a) => `    <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.assistant.acp-connector</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>WorkingDirectory</key>
  <string>${opts.targetDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${opts.targetDir}/assistant.log</string>
  <key>StandardErrorPath</key>
  <string>${opts.targetDir}/assistant.log</string>
</dict>
</plist>
`;
}

/**
 * Task Scheduler command line (Windows). Returned as a single string so the
 * caller can print it verbatim if schtasks fails.
 */
export function buildSchtasksCommand(opts: DaemonOptions): string {
  const tr = `cmd /c "cd /d ${opts.targetDir} && ${opts.command}"`;
  return `schtasks /Create /TN "Assistant" /SC ONLOGON /RL LIMITED /F /TR "${tr}"`;
}

export type ExecFn = (cmd: string) => void;

const defaultExec: ExecFn = (cmd) => execSync(cmd, { stdio: 'inherit' });

/**
 * Install autostart via the OS-native mechanism. Injectable `exec`/`write`
 * keep tests off the system. Throws on unsupported platforms or failures;
 * the wizard catches and prints manual instructions.
 */
export function installDaemon(
  platform: NodeJS.Platform,
  opts: DaemonOptions,
  exec: ExecFn = defaultExec,
  home: string = homedir()
): { mechanism: string; detail: string } {
  switch (platform) {
    case 'linux': {
      const dir = join(home, '.config', 'systemd', 'user');
      mkdirSync(dir, { recursive: true });
      const unitPath = join(dir, `${SERVICE_NAME}.service`);
      writeFileSync(unitPath, buildSystemdUnit(opts));
      exec('systemctl --user daemon-reload');
      exec(`systemctl --user enable --now ${SERVICE_NAME}.service`);
      // Best-effort: linger keeps the user service alive without a login.
      try {
        exec(`loginctl enable-linger ${process.env.USER ?? ''}`.trim());
      } catch {
        /* non-fatal */
      }
      return { mechanism: 'systemd --user', detail: unitPath };
    }
    case 'darwin': {
      const dir = join(home, 'Library', 'LaunchAgents');
      mkdirSync(dir, { recursive: true });
      const plistPath = join(dir, 'com.assistant.acp-connector.plist');
      writeFileSync(plistPath, buildLaunchdPlist(opts));
      exec(`launchctl unload ${plistPath} 2>/dev/null || true`);
      exec(`launchctl load -w ${plistPath}`);
      return { mechanism: 'launchd', detail: plistPath };
    }
    case 'win32': {
      exec(buildSchtasksCommand(opts));
      return { mechanism: 'Task Scheduler', detail: 'Task "Assistant" (ONLOGON)' };
    }
    default:
      throw new Error(`Unsupported platform for autostart: ${platform}`);
  }
}
