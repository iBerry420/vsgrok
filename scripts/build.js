'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const root = path.join(__dirname, '..');

function copyWebviewMedia() {
  const srcDir = path.join(root, 'src', 'webview', 'media');
  const destDir = path.join(root, 'dist', 'webview-media');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
  }
}

const ctxOpts = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(root, 'dist', 'extension.js'),
  external: ['vscode'],
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

async function main() {
  copyWebviewMedia();
  if (watch) {
    const ctx = await esbuild.context(ctxOpts);
    await ctx.watch();
    fs.watch(path.join(root, 'src', 'webview', 'media'), { recursive: true }, () => {
      try {
        copyWebviewMedia();
      } catch (_) {}
    });
    console.log('watching…');
  } else {
    await esbuild.build(ctxOpts);
    console.log('build ok');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
