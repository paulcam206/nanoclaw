/**
 * MXC Sandbox Runner for NanoClaw
 * Lightweight alternative to Docker containers using OS-level sandboxing
 * (AppContainer on Windows, LXC on Linux).
 *
 * Translates the Docker mount model into MXC SandboxPolicy and runs the
 * agent-runner natively inside a sandbox.
 */
import { ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getPlatformSupport,
  spawnSandbox,
  type SandboxPolicy,
  getAvailableToolsPolicy,
  getTemporaryFilesPolicy,
  getUserProfilePolicy,
} from '@microsoft/mxc-sdk';

import {
  buildVolumeMounts,
  type ContainerInput,
  type ContainerOutput,
  type VolumeMount,
} from './container-runner.js';
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const copilotEnv = readEnvFile([
  'NANOCLAW_SDK',
  'COPILOT_MODEL',
  'GITHUB_TOKEN',
]);

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Cache directory for the pre-built agent-runner. */
const AGENT_RUNNER_CACHE = path.join(DATA_DIR, 'mxc-agent-runner');

/** Check if MXC is supported on this platform. */
export function isMxcAvailable(): boolean {
  try {
    const support = getPlatformSupport();
    if (!support.isSupported) {
      logger.debug(
        { reason: support.reason },
        'MXC not supported on this platform',
      );
    }
    return support.isSupported;
  } catch (err) {
    logger.debug({ err }, 'MXC availability check failed');
    return false;
  }
}

/**
 * Ensure the agent-runner is built and cached for native execution.
 * Returns the path to the dist directory.
 */
function ensureAgentRunnerBuilt(): string {
  const agentRunnerSrc = path.join(
    process.cwd(),
    'container',
    'agent-runner',
  );
  const srcDir = path.join(agentRunnerSrc, 'src');
  const distDir = path.join(AGENT_RUNNER_CACHE, 'dist');
  const nodeModules = path.join(AGENT_RUNNER_CACHE, 'node_modules');

  // Check if rebuild needed
  let needsBuild = !fs.existsSync(distDir);
  if (!needsBuild) {
    for (const file of fs.readdirSync(srcDir)) {
      const srcFile = path.join(srcDir, file);
      const builtFile = path.join(
        distDir,
        file.replace(/\.ts$/, '.js'),
      );
      if (
        !fs.existsSync(builtFile) ||
        fs.statSync(srcFile).mtimeMs > fs.statSync(builtFile).mtimeMs
      ) {
        needsBuild = true;
        break;
      }
    }
  }

  if (!needsBuild && fs.existsSync(nodeModules)) {
    return distDir;
  }

  logger.info('Building agent-runner for MXC native execution');
  fs.mkdirSync(AGENT_RUNNER_CACHE, { recursive: true });

  // Copy package files and install deps
  fs.cpSync(
    path.join(agentRunnerSrc, 'package.json'),
    path.join(AGENT_RUNNER_CACHE, 'package.json'),
  );
  fs.cpSync(
    path.join(agentRunnerSrc, 'package-lock.json'),
    path.join(AGENT_RUNNER_CACHE, 'package-lock.json'),
  );
  fs.cpSync(
    path.join(agentRunnerSrc, 'tsconfig.json'),
    path.join(AGENT_RUNNER_CACHE, 'tsconfig.json'),
  );

  // Copy source
  const cacheSrcDir = path.join(AGENT_RUNNER_CACHE, 'src');
  fs.cpSync(srcDir, cacheSrcDir, { recursive: true });

  execSync('npm install --ignore-scripts', {
    cwd: AGENT_RUNNER_CACHE,
    stdio: 'pipe',
    timeout: 120_000,
  });

  execSync('npx tsc --outDir dist', {
    cwd: AGENT_RUNNER_CACHE,
    stdio: 'pipe',
    timeout: 60_000,
  });

  logger.info({ distDir }, 'Agent-runner built for MXC');
  return distDir;
}

/**
 * Convert Docker-style volume mounts into an MXC SandboxPolicy.
 */
function buildSandboxPolicy(mounts: VolumeMount[]): SandboxPolicy {
  const tools = getAvailableToolsPolicy(process.env);
  const profile = getUserProfilePolicy();
  const temp = getTemporaryFilesPolicy();

  const readonlyPaths = [
    ...tools.readonlyPaths,
    ...profile.readonlyPaths,
    ...mounts.filter((m) => m.readonly).map((m) => m.hostPath),
  ];

  const readwritePaths = [
    ...temp.readwritePaths,
    ...mounts.filter((m) => !m.readonly).map((m) => m.hostPath),
  ];

  return {
    version: '0.4.0-alpha',
    filesystem: {
      readonlyPaths,
      readwritePaths,
    },
    network: {
      // Agent needs outbound access for API endpoints
      allowOutbound: true,
    },
  };
}

/**
 * Build environment variables for the sandboxed agent-runner.
 * Maps Docker -e flags and container path env vars to native equivalents.
 */
function buildSandboxEnv(
  mounts: VolumeMount[],
  input: ContainerInput,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TZ: TIMEZONE,
  };

  // Map container paths to host paths via env vars.
  // The agent-runner reads these to find its workspace directories.
  for (const mount of mounts) {
    switch (mount.containerPath) {
      case '/workspace/group':
        env.NANOCLAW_GROUP_DIR = mount.hostPath;
        break;
      case '/workspace/global':
        env.NANOCLAW_GLOBAL_DIR = mount.hostPath;
        break;
      case '/workspace/extra':
        env.NANOCLAW_EXTRA_DIR = mount.hostPath;
        break;
      case '/workspace/ipc':
        env.NANOCLAW_IPC_DIR = mount.hostPath;
        break;
    }
  }

  // Additional mounts that go under /workspace/extra/
  // Create a synthetic extra directory with symlinks
  const extraMounts = mounts.filter((m) =>
    m.containerPath.startsWith('/workspace/extra/'),
  );
  if (extraMounts.length > 0 && !env.NANOCLAW_EXTRA_DIR) {
    const extraDir = path.join(
      os.tmpdir(),
      `nanoclaw-extra-${input.groupFolder}`,
    );
    fs.mkdirSync(extraDir, { recursive: true });
    for (const m of extraMounts) {
      const name = path.basename(m.containerPath);
      const linkPath = path.join(extraDir, name);
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* may not exist */
      }
      try {
        fs.symlinkSync(m.hostPath, linkPath);
      } catch {
        logger.warn(
          { hostPath: m.hostPath, linkPath },
          'Failed to create symlink for extra mount',
        );
      }
    }
    env.NANOCLAW_EXTRA_DIR = extraDir;
  }

  // Pass SDK backend and model
  const nanoclavSdk = process.env.NANOCLAW_SDK || copilotEnv.NANOCLAW_SDK;
  if (nanoclavSdk) env.NANOCLAW_SDK = nanoclavSdk;
  const copilotModel = process.env.COPILOT_MODEL || copilotEnv.COPILOT_MODEL;
  if (copilotModel) env.COPILOT_MODEL = copilotModel;

  // Pass GitHub token for Copilot SDK
  const githubToken = process.env.GITHUB_TOKEN || copilotEnv.GITHUB_TOKEN;
  if (githubToken) env.GITHUB_TOKEN = githubToken;

  // Pass IPC context for the MCP server
  env.NANOCLAW_CHAT_JID = input.chatJid;
  env.NANOCLAW_GROUP_FOLDER = input.groupFolder;
  env.NANOCLAW_IS_MAIN = input.isMain ? '1' : '0';

  return env;
}

/**
 * Run an agent inside an MXC sandbox.
 * Drop-in replacement for the Docker-based runContainerAgent.
 */
export async function runMxcAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Build the same mount set as Docker, then convert to MXC policy
  const mounts = buildVolumeMounts(group, input.isMain);
  const policy = buildSandboxPolicy(mounts);
  const env = buildSandboxEnv(mounts, input);

  // Ensure agent-runner is built for native execution
  const distDir = ensureAgentRunnerBuilt();

  // Write input JSON to a temp file (shell redirection into agent-runner)
  const inputFile = path.join(
    os.tmpdir(),
    `nanoclaw-input-${Date.now()}.json`,
  );
  fs.writeFileSync(inputFile, JSON.stringify(input));

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-mxc-${safeName}-${Date.now()}`;
  const workingDir =
    env.NANOCLAW_GROUP_DIR || resolveGroupFolderPath(group.folder);

  // Build the command to run inside the sandbox
  const agentRunnerEntry = path.join(distDir, 'index.js');
  const nodeModulesDir = path.join(AGENT_RUNNER_CACHE, 'node_modules');

  // Ensure node_modules is accessible inside the sandbox
  policy.filesystem!.readonlyPaths!.push(distDir, nodeModulesDir);

  const script =
    os.platform() === 'win32'
      ? `set "NODE_PATH=${nodeModulesDir}" && node "${agentRunnerEntry}" < "${inputFile}"`
      : `NODE_PATH="${nodeModulesDir}" node "${agentRunnerEntry}" < "${inputFile}"`;

  logger.info(
    {
      group: group.name,
      containerName,
      backend: 'mxc',
      mountCount: mounts.length,
      isMain: input.isMain,
      readonlyPaths: policy.filesystem?.readonlyPaths?.length,
      readwritePaths: policy.filesystem?.readwritePaths?.length,
    },
    'Spawning MXC sandbox agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    let ptyExited = false;

    const pty = spawnSandbox(
      script,
      policy,
      { debug: false },
      workingDir,
      containerName,
      env,
    );

    // Create a minimal ChildProcess-like adapter for GroupQueue tracking.
    // GroupQueue only reads .killed and .pid — use Object.defineProperty
    // so we can update the value despite ChildProcess declaring it readonly.
    const processAdapter = { pid: pty.pid } as unknown as ChildProcess;
    Object.defineProperty(processAdapter, 'killed', {
      value: false,
      writable: true,
      configurable: true,
    });

    const markKilled = () => {
      Object.defineProperty(processAdapter, 'killed', { value: true });
    };

    (processAdapter as unknown as { kill: () => void }).kill = () => {
      pty.kill();
      markKilled();
    };
    onProcess(processAdapter, containerName);

    let output = '';
    let outputTruncated = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;
    let timedOut = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'MXC sandbox timeout, killing',
      );
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    pty.onData((data) => {
      // Accumulate for logging
      if (!outputTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - output.length;
        if (data.length > remaining) {
          output += data.slice(0, remaining);
          outputTruncated = true;
          logger.warn(
            { group: group.name, size: output.length },
            'MXC sandbox output truncated',
          );
        } else {
          output += data;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += data;
        let startIdx: number;
        while (
          (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse MXC streamed output chunk',
            );
          }
        }
      }
    });

    pty.onExit(({ exitCode }) => {
      ptyExited = true;
      markKilled();
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Clean up temp input file
      try {
        fs.unlinkSync(inputFile);
      } catch {
        /* ignore */
      }

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration },
            'MXC sandbox timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `MXC sandbox timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `mxc-${timestamp}.log`);
      const isError = exitCode !== 0;
      const logLines = [
        `=== MXC Sandbox Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Container: ${containerName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${exitCode}`,
        `Output Truncated: ${outputTruncated}`,
        ``,
      ];
      if (isError || process.env.LOG_LEVEL === 'debug') {
        logLines.push(`=== Output ===`, output);
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (isError) {
        logger.error(
          { group: group.name, exitCode, duration },
          'MXC sandbox exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `MXC sandbox exited with code ${exitCode}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'MXC sandbox completed (streaming)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker pair
      try {
        const startIdx = output.indexOf(OUTPUT_START_MARKER);
        const endIdx = output.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = output
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = output.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const result: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: result.status },
          'MXC sandbox completed',
        );
        resolve(result);
      } catch (err) {
        logger.error(
          { group: group.name, output: output.slice(-500), error: err },
          'Failed to parse MXC sandbox output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse MXC output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  });
}
