#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const files = process.argv.slice(2);

// Change to apps/web directory and run eslint
const webDir = path.join(__dirname, '..', 'apps', 'web');
const rootDir = path.join(__dirname, '..');

// Convert file paths to relative paths from apps/web
const relativeFiles = files.map((f) => {
  const absPath = path.resolve(rootDir, f);
  const relPath = path.relative(webDir, absPath);
  return relPath.replace(/\\/g, '/');
});

execSync(
  `npx eslint ${relativeFiles.map((f) => `"${f}"`).join(' ')} --config .eslintrc.json --fix`,
  {
    stdio: 'inherit',
    cwd: webDir,
  }
);
