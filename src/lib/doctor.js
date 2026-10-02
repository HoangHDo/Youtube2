/**
 * Startup self-check. A misconfigured FFmpeg is the single most common
 * deployment failure, so we verify the binary *and* the two encoders this app
 * depends on, at boot, with the real argument list shape.
 */
import { spawn } from 'node:child_process';
import { config } from '../config/index.js';

/** @returns {Promise<{ok:boolean, version?:string, error?:string}>} */
export function probeFfmpeg() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.video.ffmpegPath, ['-hide_banner', '-version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }

    let out = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'ffmpeg -version timed out' });
    }, 8000);
    timer.unref?.();

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) =>
      finish({
        ok: false,
        error:
          err.code === 'ENOENT'
            ? `"${config.video.ffmpegPath}" is not on PATH`
            : err.message,
      }),
    );
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `ffmpeg exited with ${code}` });
      const version = out.split(/\r?\n/)[0]?.trim() ?? 'unknown';
      // The encoder list is the only reliable source of truth: `mpeg1video` is
      // built into every FFmpeg and never shows up in the --enable-* flags, so
      // grepping `-version` output gives false negatives.
      verifyEncoders().then((missing) => {
        finish(
          missing.length
            ? { ok: false, error: `ffmpeg is missing encoder(s): ${missing.join(', ')}` }
            : { ok: true, version },
        );
      });
    });
  });
}

/** @returns {Promise<string[]>} encoders this app needs but FFmpeg lacks */
function verifyEncoders() {
  const required = ['mpeg1video', 'libmp3lame'];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.video.ffmpegPath, ['-hide_banner', '-encoders'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch {
      return resolve(required);
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(required);
    }, 8000);
    timer.unref?.();
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(required));
    child.on('close', () => {
      clearTimeout(timer);
      // `-encoders` columns: flags, name, description.
      const available = new Set(
        out
          .split(/\r?\n/)
          .map((line) => /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)?.[1])
          .filter(Boolean),
      );
      resolve(required.filter((name) => !available.has(name)));
    });
  });
}

/** Same idea for yt-dlp: present, runnable, and new enough to matter. */
export function probeYtDlp() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.youtube.ytDlpPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) =>
      resolve({
        ok: false,
        error: err.code === 'ENOENT' ? `"${config.youtube.ytDlpPath}" is not on PATH` : err.message,
      }),
    );
    child.on('close', (code) =>
      resolve(
        code === 0
          ? { ok: true, version: out.trim() }
          : { ok: false, error: `yt-dlp exited with ${code}` },
      ),
    );
  });
}
