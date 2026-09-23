import { spawn, type Subprocess } from "bun";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export type TartConfig = {
  vm: string;
  user: string;
  shareName: string;
  repoDir: string;
  pkgDir: string;
};

export const GUEST_PATH = 'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"';

export const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
];

export function sshTunnelArgs(target: string, localPort: number, remotePort: number): string[] {
  return [
    "ssh",
    ...SSH_OPTS,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    target,
  ];
}

export function loadTartConfig(): TartConfig {
  const pkgDir = resolve(import.meta.dir, "../..");
  const user = process.env.TART_USER ?? "expo";
  if (!/^[A-Za-z0-9_-]+$/.test(user)) {
    throw new Error(`invalid TART_USER: ${JSON.stringify(user)}`);
  }
  return {
    vm: process.env.TART_VM ?? "tahoe-xcode",
    user,
    shareName: process.env.TART_SHARE_NAME ?? "serve-sim",
    repoDir: resolve(pkgDir, "../.."),
    pkgDir,
  };
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function guestPkgPath(config: TartConfig): string {
  return `/Volumes/My Shared Files/${config.shareName}/packages/serve-sim`;
}

export function assertHostModules(config: TartConfig): void {
  const modules = join(config.pkgDir, "node_modules");
  if (!existsSync(modules)) {
    throw new Error(`${modules} is missing. Run bun install.`);
  }
}

async function run(cmd: string[], opts?: { stdin?: string; allowFail?: boolean }): Promise<string> {
  const proc = spawn(cmd, {
    stdin: opts?.stdin != null ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0 && !opts?.allowFail) {
    const detail = (stderr || stdout).trim();
    throw new Error(`${cmd.join(" ")} failed (${exit})${detail ? `\n${detail}` : ""}`);
  }
  return stdout;
}

export class TartGuest {
  ip: string | null = null;

  constructor(readonly config: TartConfig) {}

  sshTarget(): string {
    if (!this.ip) throw new Error("guest has no IP; call connect() first");
    return `${this.config.user}@${this.ip}`;
  }

  async tartIp(): Promise<string | null> {
    const out = await run(["tart", "ip", this.config.vm], { allowFail: true });
    const ip = out.trim();
    return ip || null;
  }

  async isRunning(): Promise<boolean> {
    const out = await run(["tart", "get", this.config.vm], { allowFail: true });
    return /\brunning\b/.test(out);
  }

  async connect(): Promise<void> {
    this.ip = await this.tartIp();
    if (!this.ip) throw new Error(`${this.config.vm} has no IP`);
  }

  async ssh(script: string): Promise<string> {
    return run(["ssh", ...SSH_OPTS, this.sshTarget(), "bash", "-s"], { stdin: script });
  }

  async sshInherit(script: string): Promise<number> {
    return this.sshSpawn(script).exited;
  }

  sshSpawn(script: string): Subprocess {
    return spawn(["ssh", ...SSH_OPTS, this.sshTarget(), "bash", "-s"], {
      stdin: Buffer.from(script),
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  tunnel(localPort: number, remotePort: number): Subprocess {
    return spawn(sshTunnelArgs(this.sshTarget(), localPort, remotePort), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
  }

  async scp(files: string[], dest: string): Promise<void> {
    await run(["scp", ...SSH_OPTS, ...files, `${this.sshTarget()}:${dest}`]);
  }

  async tarTo(srcDir: string, paths: string[], destDir: string): Promise<void> {
    const tar = spawn(["tar", "-C", srcDir, "-cf", "-", ...paths], { stdout: "pipe", stderr: "pipe" });
    const ssh = spawn(["ssh", ...SSH_OPTS, this.sshTarget(), "tar", "-C", destDir, "-xf", "-"], {
      stdin: tar.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [tarStderr, sshStderr, tarExit, sshExit] = await Promise.all([
      new Response(tar.stderr).text(),
      new Response(ssh.stderr).text(),
      tar.exited,
      ssh.exited,
    ]);
    if (tarExit !== 0) {
      throw new Error(`stage tar failed (${tarExit})${tarStderr ? `\n${tarStderr}` : ""}`);
    }
    if (sshExit !== 0) {
      throw new Error(`stage tar failed (${sshExit})${sshStderr ? `\n${sshStderr}` : ""}`);
    }
  }

  async sshOk(command: string[]): Promise<boolean> {
    const proc = spawn(["ssh", ...SSH_OPTS, this.sshTarget(), ...command], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  }

  async exec(args: string[], opts?: { allowFail?: boolean; stdin?: string }): Promise<string> {
    const interactive = opts?.stdin != null ? ["-i"] : [];
    return run(["tart", "exec", ...interactive, this.config.vm, ...args], opts);
  }

  async execOk(args: string[]): Promise<boolean> {
    const proc = spawn(["tart", "exec", this.config.vm, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  }

  async waitSsh(tries = 40): Promise<void> {
    for (let i = 0; i < tries; i++) {
      this.ip = await this.tartIp();
      if (this.ip && (await this.sshOk(["true"]))) return;
      await Bun.sleep(2000);
    }
    throw new Error(`could not SSH to ${this.config.user}@${this.config.vm}. Run: bun run tart setup`);
  }

  async ensureRunning(): Promise<void> {
    if (await this.isRunning()) {
      await this.connect();
      return;
    }

    console.log(`starting ${this.config.vm} with ${this.config.repoDir} mounted as ${this.config.shareName}`);
    const logDir = join(this.config.pkgDir, "dist");
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, "tart-run.log");
    writeFileSync(log, "");
    const child = spawn(
      [
        "tart",
        "run",
        "--no-graphics",
        "--no-clipboard",
        "--no-audio",
        "--dir",
        `${this.config.shareName}:${this.config.repoDir}`,
        this.config.vm,
      ],
      { stdout: "ignore", stderr: Bun.file(log), stdin: "ignore", detached: true },
    );
    child.unref();
    for (let i = 0; i < 60; i++) {
      this.ip = await this.tartIp();
      if (this.ip) return;
      if (child.exitCode != null || child.signalCode != null) {
        const how = child.signalCode ?? `code ${child.exitCode}`;
        throw new Error(
          `tart run ${this.config.vm} exited (${how}). Another checkout may already hold the VM. Run \`tart list\` to see what is running. ${logTail(log)}`,
        );
      }
      await Bun.sleep(2000);
    }
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error(
      `${this.config.vm} never got an IP after 120s, so tart run was stopped. The VM likely never got a DHCP lease. Run \`tart run ${this.config.vm}\` by hand to watch it boot. ${logTail(log)}`,
    );
  }

  async assertShare(): Promise<void> {
    const share = guestPkgPath(this.config);
    const srcQuoted = shellEscape(`${share}/src`);
    const stopHint = `Stop the VM with \`tart stop ${this.config.vm}\` and rerun bun run tart up.`;

    const stampDir = join(this.config.pkgDir, "dist");
    mkdirSync(stampDir, { recursive: true });
    const stamp = join(stampDir, ".tart-share");
    const token = `${this.config.repoDir}:${process.pid}:${Date.now()}`;
    writeFileSync(stamp, token);
    try {
      const remote = `${share}/dist/.tart-share`;
      let present = false;
      for (let i = 0; i < 15; i++) {
        present = (await this.ssh(`if test -d ${srcQuoted}; then echo ok; fi`)).trim() === "ok";
        if (present) break;
        await Bun.sleep(400);
      }
      if (!present) {
        throw new Error(`VM share is missing (${share}). ${stopHint}`);
      }
      for (let i = 0; i < 15; i++) {
        const seen = (await this.ssh(`cat ${shellEscape(remote)} 2>/dev/null || true`)).trim();
        if (seen === token) return;
        await Bun.sleep(400);
      }
      throw new Error(`VM share is not this checkout (${this.config.repoDir}). ${stopHint}`);
    } finally {
      try {
        unlinkSync(stamp);
      } catch {}
    }
  }
}

export function logTail(path: string): string {
  let text = "";
  try {
    text = readFileSync(path, "utf-8").trim();
  } catch {}
  if (!text) return `See ${path}.`;
  return `tart run said:\n${text.split("\n").slice(-10).join("\n")}`;
}

function publicKey(): string {
  for (const name of ["id_ed25519.pub", "id_rsa.pub"]) {
    const path = `${homedir()}/.ssh/${name}`;
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  }
  throw new Error("no ~/.ssh/id_ed25519.pub or id_rsa.pub");
}

export async function setupGuest(guest: TartGuest): Promise<void> {
  const { user } = guest.config;
  const pub = publicKey();
  if (!(await guest.isRunning())) {
    throw new Error("start the VM first (bun run tart up)");
  }
  await guest.connect();

  if (!(await guest.execOk(["id", user]))) {
    await guest.exec(["sudo", "sysadminctl", "-addUser", user, "-password", user, "-fullName", user]);
  }
  await guest.exec(["sudo", "systemsetup", "-setremotelogin", "on"], { allowFail: true });
  await guest.exec(["sudo", "dseditgroup", "-o", "edit", "-a", user, "-t", "user", "com.apple.access_ssh"], {
    allowFail: true,
  });

  const hom = (await guest.exec(["dscl", ".", "-read", `/Users/${user}`, "NFSHomeDirectory"])).trim().split(/\s+/).at(-1);
  if (!hom?.startsWith("/")) throw new Error(`no home directory for ${user}`);
  const sshDir = `${hom}/.ssh`;
  const keys = `${sshDir}/authorized_keys`;
  await guest.exec(["sudo", "mkdir", "-p", sshDir]);
  await guest.exec(["sudo", "touch", keys]);
  const existing = await guest.exec(["sudo", "cat", keys], { allowFail: true });
  if (!existing.split("\n").includes(pub)) {
    await guest.exec(["sudo", "tee", "-a", keys], { stdin: `${pub}\n` });
  }
  await guest.exec(["sudo", "chmod", "700", sshDir]);
  await guest.exec(["sudo", "chmod", "600", keys]);
  await guest.exec(["sudo", "chown", "-R", `${user}:staff`, sshDir]);
  await guest.waitSsh();

  if ((await guest.ssh('if test -x "$HOME/.bun/bin/bun"; then echo ok; fi')).trim() !== "ok") {
    const bunBin = Bun.which("bun");
    if (!bunBin) throw new Error("bun is not on the host PATH");
    await guest.scp([bunBin], "/tmp/bun");
    await guest.ssh('mkdir -p "$HOME/.bun/bin" && mv /tmp/bun "$HOME/.bun/bin/bun" && chmod +x "$HOME/.bun/bin/bun"');
  }
  console.log(`setup ok (${guest.config.user}@${guest.ip})`);
}
