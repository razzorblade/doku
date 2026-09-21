/** Expected, user-facing failure. The CLI prints the message without a stack trace. */
export class DokuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DokuError';
  }
}
