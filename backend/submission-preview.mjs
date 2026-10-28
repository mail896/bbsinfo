import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMediaJob } from './media-jobs.mjs';

export const maxPreviewPages = 100;
const RENDERER = fileURLToPath(new URL('./render_submission_page.py', import.meta.url));

function run(command, args, maxBytes, timeoutMs) {
  return runMediaJob(() => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const chunks = [];
    let size = 0;
    let processError = null;
    const fail = (message) => {
      processError ||= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('PDF-Vorschau konnte nicht erstellt werden.'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) fail('PDF-Vorschau konnte nicht erstellt werden.');
      else chunks.push(chunk);
    });
    child.stdout.once('error', () => fail('PDF-Vorschau konnte nicht erstellt werden.'));
    child.once('error', () => { processError ||= new Error('PDF-Vorschau nicht verfügbar.'); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (processError || code !== 0 || size > maxBytes) reject(processError || new Error('PDF-Vorschau konnte nicht erstellt werden.'));
      else resolve(Buffer.concat(chunks));
    });
  }));
}

export async function countPdfPages(path) {
  const script = 'import sys; from pypdf import PdfReader; print(len(PdfReader(sys.argv[1], strict=False).pages))';
  const output = await run('/usr/bin/python3', ['-I', '-c', script, path], 100, 10000);
  const count = Number(output.toString().trim());
  if (!Number.isSafeInteger(count) || count < 1 || count > maxPreviewPages) throw new Error('PDF-Seitenzahl außerhalb des Vorschaubereichs.');
  return count;
}

export async function renderPdfPage(path, page) {
  if (!Number.isSafeInteger(page) || page < 1 || page > maxPreviewPages) throw new Error('Ungültige PDF-Seite.');
  const data = await run('/usr/bin/python3', ['-I', RENDERER, path, String(page)], 6 * 1024 * 1024, 18000);
  if (data.length < 100 || data.subarray(0, 4).toString() !== 'RIFF' || data.subarray(8, 12).toString() !== 'WEBP') throw new Error('PDF-Seite konnte nicht gerendert werden.');
  return data;
}
