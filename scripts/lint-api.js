#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const files = process.argv.slice(2);

// Change to apps/api directory and run eslint
const apiDir = path.join(__dirname, '..', 'apps', 'api');
const rootDir = path.join(__dirname, '..');

// Convert file paths to relative paths from apps/api
const relativeFiles = files.map((f) => {
  const absPath = path.resolve(rootDir, f);
  const relPath = path.relative(apiDir, absPath);
  return relPath.replace(/\\/g, '/');
});

execSync(`npx eslint ${relativeFiles.map((f) => `"${f}"`).join(' ')} --ext .ts --fix`, {
  stdio: 'inherit',
  cwd: apiDir,
});
