import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSubmissionFile } from './submission-files.mjs';
import { runMediaJob } from './media-jobs.mjs';

const SCRIPT = fileURLToPath(new URL('./render_issue_pdf.py', import.meta.url));
const maxPdfBytes = 64 * 1024 * 1024;

export async function renderIssuePdf(issue, editorImageRoot, submissionRoot = null) {
  const attachments = [];
  for (const attachment of issue.attachments || []) {
    if (!submissionRoot) throw new Error('Steckbriefspeicher nicht verfügbar.');
    const file = await getSubmissionFile(submissionRoot, attachment.storedName);
    attachments.push({ title: attachment.title, mediaType: attachment.mediaType, path: file.path });
  }
  const payload = JSON.stringify({ issue: { ...issue, attachments }, editorImageRoot });
  return runMediaJob(() => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const chunks = [];
    let size = 0;
    let processError = null;
    const fail = (message) => {
      processError ||= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('PDF konnte nicht erstellt werden.'), 45000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxPdfBytes) fail('PDF konnte nicht erstellt werden.');
      else chunks.push(chunk);
    });
    child.stdout.once('error', () => fail('PDF konnte nicht erstellt werden.'));
    child.once('error', () => { processError ||= new Error('PDF-Erzeugung nicht verfügbar.'); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (processError || code !== 0 || size <= 100 || size > maxPdfBytes) reject(processError || new Error('PDF konnte nicht erstellt werden.'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.once('error', () => fail('PDF konnte nicht erstellt werden.'));
    try { child.stdin.end(payload); }
    catch { fail('PDF konnte nicht erstellt werden.'); }
  }));
}
