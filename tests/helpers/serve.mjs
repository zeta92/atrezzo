// Starts `atrezzo serve` as a child process. Talks HTTP only through ./http.mjs.
import { spawn } from 'node:child_process';
import { CLI } from '../helpers.mjs';
import { getJson } from './http.mjs';

/** `atrezzo serve --port 0 ...args` in `dir` ⇒ { url, stop(), log() } once it answers. */
export function startServe(dir, args = []) {
  return new Promise((ok, ko) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], { cwd: dir });
    let buf = '';
    let url = null;
    const handle = { get url() { return url; }, stop: () => child.kill(), log: () => buf };
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m && !url) {
        url = `http://127.0.0.1:${m[1]}`;
        getJson(`${url}/__atrezzo/state`).then(() => ok(handle), (e) => { child.kill(); ko(e); });
      }
    });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('exit', (code) => { if (!url) ko(new Error(`serve exited with ${code}: ${buf}`)); });
  });
}
