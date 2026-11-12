import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => String(value).replace(/[<>&"']/g, character => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[character]));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return response;
}

async function signNativeFiles(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await signNativeFiles(file);
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || entry.name === 'spawn-helper') {
      if (entry.name === 'spawn-helper') await chmod(file, 0o755);
      await exec('codesign', ['--force', '--sign', '-', file]);
    }
  }
}

async function build() {
  if (process.platform !== 'darwin') throw new Error('Build on macOS: this installer requires swiftc, codesign, and hdiutil. Use the macOS installer GitHub Actions workflow.');
  if (!['arm64', 'x64'].includes(process.arch) || Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Build with native Apple Silicon or Intel Node.js 22+.');
  }
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omp-workspace-macos-'));
  try {
    const image = path.join(temporary, 'image');
    const app = path.join(image, 'OMP Workspace.app');
    const contents = path.join(app, 'Contents');
    const binaries = path.join(contents, 'MacOS');
    const resources = path.join(contents, 'Resources');
    const workspace = path.join(resources, 'workspace');
    await mkdir(binaries, {recursive: true});
    await mkdir(workspace, {recursive: true});
    const iconset = path.join(temporary, 'Workspace.iconset');
    await mkdir(iconset);
    const iconSource = path.join(root, 'public', 'icon-1024.png');
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        await exec('sips', ['-z', String(pixels), String(pixels), iconSource, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
      }
    }
    await exec('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Workspace.icns')]);

    // Fetch the official standalone runtime, not a Homebrew-linked host binary.
    const archiveName = `node-${process.version}-darwin-${process.arch}.tar.gz`;
    const base = `https://nodejs.org/dist/${process.version}/`;
    const checksums = await (await download(`${base}SHASUMS256.txt`)).text();
    const checksum = checksums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archiveName)?.[0];
    if (!checksum) throw new Error(`No official Node checksum found for ${archiveName}`);
    const archive = path.join(temporary, archiveName);
    await pipeline(Readable.fromWeb((await download(`${base}${archiveName}`)).body), createWriteStream(archive));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== checksum) throw new Error('Node runtime checksum mismatch.');
    await exec('tar', ['-xzf', archive, '-C', temporary]);
    const runtime = path.join(temporary, archiveName.replace(/\.tar\.gz$/, ''));
    const node = path.join(binaries, 'node');
    await copyFile(path.join(runtime, 'bin', 'node'), node);
    await chmod(node, 0o755);
    await copyFile(path.join(runtime, 'LICENSE'), path.join(resources, 'Node-LICENSE'));

    for (const name of ['package.json', 'package-lock.json', 'launch.mjs', 'server.mjs', 'storage.mjs', 'terminal.mjs', 'extension.mjs', 'public']) {
      await cp(path.join(root, name), path.join(workspace, name), {recursive: true});
    }
    const environment = {...process.env, PATH: `${binaries}${path.delimiter}${process.env.PATH}`};
    const installed = await exec('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {cwd: workspace, env: environment});
    process.stdout.write(installed.stdout);
    const prebuilds = path.join(workspace, 'node_modules', 'node-pty', 'prebuilds');
    for (const entry of await readdir(prebuilds).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (entry !== `darwin-${process.arch}`) await rm(path.join(prebuilds, entry), {recursive: true, force: true});
    }
    await signNativeFiles(workspace);
    await exec('codesign', ['--force', '--sign', '-', node]);

    const target = `${process.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`;
    await exec('swiftc', ['-O', '-target', target, '-framework', 'AppKit', '-framework', 'WebKit', path.join(root, 'packaging', 'macos', 'main.swift'), '-o', path.join(binaries, 'OMP Workspace')]);
    await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>OMP Workspace</string>
<key>CFBundleDisplayName</key><string>OMP Workspace</string>
<key>CFBundleIdentifier</key><string>local.omp.workspace</string>
<key>CFBundleExecutable</key><string>OMP Workspace</string>
<key>CFBundleIconFile</key><string>Workspace.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(metadata.version)}</string>
<key>CFBundleVersion</key><string>${xml(metadata.version)}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSAppTransportSecurity</key><dict>
<key>NSAllowsLocalNetworking</key><true/>
<key>NSAllowsArbitraryLoadsInWebContent</key><true/>
</dict>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
    await exec('plutil', ['-lint', path.join(contents, 'Info.plist')]);
    await exec('codesign', ['--force', '--sign', '-', app]);
    await exec('codesign', ['--verify', '--deep', '--strict', app]);

    // Exercise the packaged runtime and native PTY before distributing the image.
    await exec(node, ['--input-type=module', '-e', `
      import {createRequire} from 'node:module';
      const require = createRequire(process.cwd() + '/package.json');
      const pty = require('node-pty');
      let output = '';
      const terminal = pty.spawn('/bin/sh', ['-c', 'printf OMP_PTY_OK'], {cols: 80, rows: 24, env: process.env});
      const timer = setTimeout(() => { terminal.kill(); process.exit(1); }, 5000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({exitCode}) => {
        clearTimeout(timer);
        if (exitCode !== 0 || !output.includes('OMP_PTY_OK')) process.exit(1);
        console.log('Packaged Node and native PTY: OK');
      });
    `], {cwd: workspace, timeout: 10000});
    const smokeRoot = path.join(temporary, 'smoke-repository');
    await mkdir(smokeRoot);
    const smokeOptions = {
      cwd: workspace, timeout: 35000,
      env: {...environment, LOCALAPPDATA: path.join(temporary, 'state'), PI_CODING_AGENT_DIR: path.join(temporary, 'agent')},
    };
    const launcher = path.join(workspace, 'launch.mjs');
    try {
      const launched = await exec(node, [launcher, '--root', smokeRoot, '--no-open'], smokeOptions);
      const url = launched.stdout.match(/Local window: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)?.[1];
      if (!url) throw new Error('Packaged workspace did not publish its launch URL.');
      const signedIn = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(5000)});
      const cookie = signedIn.headers.get('set-cookie')?.split(';')[0];
      if (signedIn.status !== 303 || !cookie) throw new Error('Packaged workspace sign-in failed.');
      const health = await fetch(new URL('/api/health', url), {headers: {Cookie: cookie}, signal: AbortSignal.timeout(5000)});
      if (!health.ok || !(await health.json()).ok) throw new Error('Packaged workspace health check failed.');
      const page = await fetch(new URL('/', url), {headers: {Cookie: cookie}, signal: AbortSignal.timeout(5000)});
      if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error('Packaged workspace page failed to load.');
      console.log('Packaged workspace launch and authenticated HTTP: OK');
    } finally {
      await exec(node, [launcher, '--root', smokeRoot, '--stop'], smokeOptions);
    }
    await symlink('/Applications', path.join(image, 'Applications'));
    const outputDirectory = path.join(root, 'dist');
    await mkdir(outputDirectory, {recursive: true});
    const output = path.join(outputDirectory, `OMP-Workspace-${metadata.version}-macos-${process.arch}.dmg`);
    await exec('hdiutil', ['create', '-volname', 'OMP Workspace', '-srcfolder', image, '-format', 'UDZO', '-ov', output]);
    await exec('hdiutil', ['verify', output]);
    console.log(`Created ${output}\nAd-hoc signed only; not Developer ID signed or notarized.`);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
