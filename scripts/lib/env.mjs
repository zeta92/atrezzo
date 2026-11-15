// The only place that touches the process environment, and it reads exactly one name:
// ATREZZO_CHROME, the path of a Chromium binary for the playwright driver. It is not a secret.
//
// Header values are never read from the environment, a file the plugin picks, .netrc or a
// keychain: the user hands them to `verify --header` on the command line (or on stdin).
export function chromePath() {
  return process.env.ATREZZO_CHROME || undefined;
}
