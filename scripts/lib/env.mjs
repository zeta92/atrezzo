// The only place that touches the process environment.
//
// Values come from the shell that ran the command: the plugin never reads .env, .netrc or a
// keychain, never persists what it finds, and secret-looking headers are printed as ***.
export function env() {
  return process.env;
}
