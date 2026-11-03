import { main } from './index';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
  });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exit(1);
  }
);
