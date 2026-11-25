/**
 * A CLI error that is the person's situation, not a bug: printed as a
 * sentence and a fix, never a stack trace. `code` is the server's error
 * code when there was one (it goes into --json output).
 */
export class Refused extends Error {
  constructor(message, { code = null, status = null, retryAfter = null, exitCode = 1 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.exitCode = exitCode;
    this.expected = true;
  }
}
