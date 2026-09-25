import readline from 'node:readline';

/** Asks the user questions. Commands take one as an option so tests can script the answers. */
export interface Prompter {
  /** One line of input, or null once input has ended (e.g. stdin is not a terminal). */
  ask(question: string): Promise<string | null>;
  /** Like `ask`, without echoing what is typed (keys, passphrases). Falls back to `ask`. */
  askSecret?(question: string): Promise<string | null>;
  close(): void;
}

/** Apply backspaces typed in raw mode, where the terminal does no line editing. */
function applyBackspaces(raw: string): string {
  const out: string[] = [];
  for (const ch of raw) {
    if (ch === '\x7f' || ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

/** Reads answers line by line from stdin; works with a terminal and with piped input. */
export function stdinPrompter(): Prompter {
  let rl: readline.Interface | undefined;
  const lines: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let ended = false;
  const open = () => {
    if (rl) return;
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const w = waiting;
      waiting = undefined;
      if (w) w(line);
      else lines.push(line);
    });
    rl.on('close', () => {
      ended = true;
      if (waiting) process.stdout.write('\n');
      waiting?.(null);
      waiting = undefined;
    });
  };
  const nextLine = (): Promise<string | null> => {
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (ended) {
      process.stdout.write('\n');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => (waiting = resolve));
  };
  return {
    ask(question) {
      open();
      process.stdout.write(question);
      return nextLine();
    },
    async askSecret(question) {
      const stdin = process.stdin;
      if (!stdin.isTTY) return this.ask(question);
      open();
      process.stdout.write(question);
      // Raw mode turns off the terminal's echo. Enter still ends the line for readline.
      const onData = (chunk: Buffer) => {
        if (chunk.includes(3)) {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
      };
      stdin.setRawMode(true);
      stdin.on('data', onData);
      try {
        const line = await nextLine();
        return line === null ? null : applyBackspaces(line);
      } finally {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        process.stdout.write('\n');
      }
    },
    close() {
      rl?.close();
    },
  };
}

export function askSecret(p: Prompter, question: string): Promise<string | null> {
  return p.askSecret ? p.askSecret(question) : p.ask(question);
}

/** Yes/no question. Without input the answer is always no, whatever the default. */
export async function confirm(p: Prompter, question: string, def = false): Promise<boolean> {
  for (;;) {
    const answer = await p.ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `);
    if (answer === null) return false;
    const v = answer.trim().toLowerCase();
    if (!v) return def;
    if (v === 'y' || v === 'yes') return true;
    if (v === 'n' || v === 'no') return false;
  }
}

export interface Choice<T extends string> {
  key: string;
  value: T;
  label: string;
}

/** Pick one of `choices` by key. Enter picks `def`; no input at all picks `noInput` (default: `def`). */
export async function choose<T extends string>(p: Prompter, question: string, choices: Choice<T>[], def: T, noInput: T = def): Promise<T> {
  const keys = choices.map((c) => (c.value === def ? c.key.toUpperCase() : c.key)).join('/');
  for (;;) {
    const answer = await p.ask(`${question}\n${choices.map((c) => `  [${c.key}] ${c.label}`).join('\n')}\nChoose [${keys}]: `);
    if (answer === null) return noInput;
    const v = answer.trim().toLowerCase();
    if (!v) return def;
    const hit = choices.find((c) => c.key === v || c.value === v);
    if (hit) return hit.value;
  }
}
