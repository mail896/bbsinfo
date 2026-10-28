import { subscriberDeliveryEnabled, subscriberRecipientAllowed, sendSubscriberDigest } from './mail.mjs';

export function isWeeklyMailWindow(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp)).filter((item) => item.type === 'weekday' || item.type === 'hour').map((item) => [item.type, item.value]));
  return parts.weekday === 'Mon' && parts.hour === '07';
}

export function isDailyMailWindow(timestamp) {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));
  return Number(hour) >= 18;
}

export function dailyCutoffUtc(timestamp) {
  if (!isDailyMailWindow(timestamp)) throw new Error('Außerhalb des täglichen Versandfensters.');
  const date = new Date(timestamp);
  const berlinHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(date));
  date.setUTCHours(date.getUTCHours() - (berlinHour - 18), 0, 0, 0);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function deliverPendingUpdates(store, config, mode, send = sendSubscriberDigest, cutoffUtc = null, verifyGroup = null, scanState = null, checkAfterClaim = false) {
  if (!subscriberDeliveryEnabled(config)) return 0;
  const rows = await store.pendingUpdateMail(mode, 50, cutoffUtc, scanState?.afterUserUuid || null);
  const grouped = new Map();
  for (const row of rows) {
    if (!subscriberRecipientAllowed(config, row.email)) continue;
    if (!grouped.has(row.userUuid)) grouped.set(row.userUuid, { email: row.email, updates: [] });
    grouped.get(row.userUuid).updates.push(row);
  }
  let delivered = 0;
  for (const [userUuid, group] of grouped) {
    const ids = group.updates.map((row) => Number(row.id));
    try {
      if (verifyGroup && (await verifyGroup(userUuid, group.email)) !== true) continue;
    } catch (error) {
      // Continue after this account next tick, then wrap back to retry it later.
      if (scanState) scanState.afterUserUuid = userUuid;
      throw error;
    }
    if (!(await store.claimUpdateMail(userUuid, ids, mode, cutoffUtc))) continue;
    if (checkAfterClaim) {
      let stillMember;
      try { stillMember = (await verifyGroup(userUuid, group.email)) === true; }
      catch (error) {
        if (scanState) scanState.afterUserUuid = userUuid;
        await store.releaseUpdateMail(userUuid, ids);
        throw error;
      }
      if (!stillMember) {
        await store.releaseUpdateMail(userUuid, ids);
        continue;
      }
    }
    try {
      await send(config, group.email, group.updates);
    } catch {
      try { await store.finishUpdateMail(userUuid, ids, false); }
      catch { process.stderr.write('BBS Info: Update-Mail konnte nicht abgeschlossen werden; kein erneuter Versand.\n'); }
      process.stderr.write('BBS Info: Update-Mailstatus unklar; kein automatischer erneuter Versand.\n');
      continue;
    }
    try {
      await store.finishUpdateMail(userUuid, ids, true);
      delivered += ids.length;
    } catch {
      // SMTP has already accepted the message. The reservation remains durable
      // even if the final database transaction failed or its commit is unknown.
      process.stderr.write('BBS Info: Update-Mail vom Mailserver angenommen; Datenbank-Abschluss unklar, kein erneuter Versand.\n');
    }
  }
  // A revoked account must not keep the first 50 pending rows ahead of other subscribers forever.
  if (scanState) scanState.afterUserUuid = rows.length === 50 ? rows.at(-1).userUuid : null;
  return delivered;
}

// All production callers must enter here; the legacy helper remains for isolated transport tests.
export async function deliverVerifiedUpdates(store, config, mode, verifyGroup, send = sendSubscriberDigest, cutoffUtc = null, scanState = null) {
  if (typeof verifyGroup !== 'function') throw new Error('IDM-Prüfer fehlt; persönlicher Mailversand pausiert.');
  if (typeof store?.releaseUpdateMail !== 'function') throw new Error('Freigabe für Mailreservierungen fehlt.');
  return deliverPendingUpdates(store, config, mode, send, cutoffUtc, verifyGroup, scanState, true);
}
