import { spawn } from 'node:child_process';

function pnpmBin() {
  return 'pnpm';
}

function runPnpm(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['run', script];
    console.log(`Running: pnpm ${args.join(' ')}`);

    const child = spawn(pnpmBin(), args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (exit ${code}): pnpm ${args.join(' ')}`));
    });
  });
}

async function main() {
  console.log('Reinitializing season data...');

  // Minimum data foundation for a new season.
  await runPnpm('db:seed:brackets');
  await runPnpm('data:sync-teams');
  await runPnpm('data:sync-players');
  await runPnpm('data:sync-gameweeks');
  await runPnpm('sync:entries');
  await runPnpm('jobs:plan');

  console.log('Reinitialize complete.');
}

main().catch((e) => {
  console.error('reinitializeSeasonData failed:', e);
  process.exitCode = 1;
});
