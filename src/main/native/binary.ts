import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from 'electron';

import { pathExists } from '../storage';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

export function getHelperBinaryPath(): string {
  const name = isWindows ? 'yap-helper.exe' : 'yap-helper';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', name)
    : path.join(projectRoot, 'build', 'native', name);
}

function getHelperSourcePath(): string {
  if (isWindows) return path.join(projectRoot, 'windows', 'YapHelper.cpp');
  if (isLinux) return path.join(projectRoot, 'linux', 'YapHelper.cpp');
  return path.join(projectRoot, 'swift', 'YapHelper.swift');
}

async function modifiedAt(target: string): Promise<number> {
  try {
    return (await stat(target)).mtimeMs;
  } catch {
    return 0;
  }
}

function compile(source: string, output: string): Promise<boolean> {
  const [command, args] = isWindows
    ? ['g++', ['-O2', '-o', output, source, '-luser32', '-lkernel32']]
    : isLinux
      ? ['g++', ['-O2', '-o', output, source, '-lX11', '-lXi', '-lXtst']]
      : ['swiftc', ['-O', '-swift-version', '5', source, '-o', output]];

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code !== 0) {
        console.error('[yap] helper compilation failed:', stderr.trim());
      }
      resolve(code === 0);
    });
  });
}

/**
 * Makes sure a helper binary exists. Development builds compile it from
 * source when it is missing or older than the source, so a protocol change
 * in the helper can never meet a stale binary.
 */
export async function ensureHelperBinary(): Promise<string | null> {
  const binary = getHelperBinaryPath();

  if (app.isPackaged) {
    return (await pathExists(binary)) ? binary : null;
  }

  const source = getHelperSourcePath();
  if (!(await pathExists(source))) {
    return (await pathExists(binary)) ? binary : null;
  }

  if ((await modifiedAt(binary)) < (await modifiedAt(source))) {
    await mkdir(path.dirname(binary), { recursive: true });
    console.log('[yap] compiling the native helper…');
    if (!(await compile(source, binary))) {
      return (await pathExists(binary)) ? binary : null;
    }
  }

  return binary;
}
