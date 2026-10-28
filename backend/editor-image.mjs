import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMediaJob } from './media-jobs.mjs';

const script = fileURLToPath(new URL('./editor_image.py', import.meta.url));

function run(args, input = null) {
  return runMediaJob(() => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', script, ...args], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const chunks = [];
    let length = 0;
    let processError = null;
    const fail = (message) => {
      processError ||= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('Bild konnte nicht optimiert werden.'), 15000);
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > 3 * 1024 * 1024) fail('Bild konnte nicht optimiert werden.');
      else chunks.push(chunk);
    });
    child.stdout.once('error', () => fail('Bild konnte nicht optimiert werden.'));
    child.once('error', () => { processError ||= new Error('Bildoptimierung nicht verfügbar.'); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = Buffer.concat(chunks);
      if (processError || code !== 0 || result.subarray(0, 4).toString() !== 'RIFF' || result.subarray(8, 12).toString() !== 'WEBP') reject(processError || new Error('Bild konnte nicht optimiert werden.'));
      else resolve(result);
    });
    child.stdin.once('error', () => fail('Bild konnte nicht optimiert werden.'));
    try { child.stdin.end(input || undefined); }
    catch { fail('Bild konnte nicht optimiert werden.'); }
  }));
}

export const optimizeEditorUpload = (data) => run(['upload'], data);
export const renderEditorImageVariant = (path, width) => run(['variant', path, String(width)]);
