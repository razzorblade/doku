import pc from 'picocolors';

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(`${pc.green('✓')} ${msg}`),
  warn: (msg: string) => console.log(`${pc.yellow('!')} ${msg}`),
  step: (msg: string) => console.log(pc.dim(`› ${msg}`)),
  error: (msg: string) => console.error(`${pc.red('✗')} ${msg}`),
};

export { pc };
