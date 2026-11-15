// The only place that touches the process environment.
//
// Used for two things only: ${VAR} in flow headers (the value the user put in the shell that ran
// the command) and ATREZZO_CHROME (a browser path). The plugin never reads .netrc or a keychain,
// never persists what it finds, and secret-looking headers are printed as ***.
export function env() {
  return process.env;
}
