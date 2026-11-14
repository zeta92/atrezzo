// Exit codes shared by the CLI:
//   0 OK · 1 assertion failed · 2 could not verify (missing tool/server) · 3 invalid input
export const EXIT = { OK: 0, FAIL: 1, UNVERIFIABLE: 2, INVALID: 3 };

export class AtrezzoError extends Error {
  /**
   * @param {string} message summary line
   * @param {{ exitCode?: number, issues?: string[] }} [opts]
   */
  constructor(message, { exitCode = EXIT.INVALID, issues = [] } = {}) {
    super(issues.length ? `${message}\n${issues.map((i) => `  - ${i}`).join('\n')}` : message);
    this.name = 'AtrezzoError';
    this.exitCode = exitCode;
    this.issues = issues;
  }
}
