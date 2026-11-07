import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectRoot, 'build', 'native');

mkdirSync(outputDir, { recursive: true });

/* The helper ships as a universal binary, so one build works on Apple
   Silicon and Intel no matter which machine produced it. */
function buildMac() {
  const source = path.join(projectRoot, 'swift', 'YapHelper.swift');
  const output = path.join(outputDir, 'yap-helper');
  const slices = [];

  // Both slices are required: an app shipped with a one-architecture helper
  // would install fine and then have no hotkey on the other kind of Mac.
  // The language mode is pinned so a newer compiler default cannot break it.
  for (const arch of ['arm64', 'x86_64']) {
    const slice = path.join(outputDir, `yap-helper-${arch}`);
    console.log(`[build] Compiling Swift helper (${arch})...`);
    execFileSync('swiftc', ['-O', '-swift-version', '5', '-target', `${arch}-apple-macos12.0`, source, '-o', slice], {
      stdio: 'inherit',
    });
    slices.push(slice);
  }

  execFileSync('lipo', ['-create', ...slices, '-output', output], { stdio: 'inherit' });
  for (const slice of slices) rmSync(slice, { force: true });
  execFileSync('lipo', ['-info', output], { stdio: 'inherit' });
}

function buildWindows() {
  const source = path.join(projectRoot, 'windows', 'YapHelper.cpp');
  const output = path.join(outputDir, 'yap-helper.exe');
  console.log('[build] Compiling C++ helper for Windows...');
  try {
    execFileSync('cl.exe', ['/O2', '/W3', source, '/link', 'user32.lib', 'kernel32.lib', `/out:${output}`], { stdio: 'inherit' });
  } catch {
    console.log('[build] cl.exe not found. Trying g++ (MinGW)...');
    execFileSync('g++', ['-O2', '-o', output, source, '-luser32', '-lkernel32'], { stdio: 'inherit' });
  }
}

function buildLinux() {
  const source = path.join(projectRoot, 'linux', 'YapHelper.cpp');
  const output = path.join(outputDir, 'yap-helper');
  console.log('[build] Compiling C++ helper for Linux (X11)...');
  execFileSync('g++', ['-O2', '-Wall', '-o', output, source, '-lX11', '-lXi', '-lXtst'], { stdio: 'inherit' });
}

if (process.platform === 'darwin') {
  buildMac();
} else if (process.platform === 'win32') {
  buildWindows();
} else if (process.platform === 'linux') {
  buildLinux();
} else {
  console.log(`[build] No native helper for ${process.platform}.`);
}
