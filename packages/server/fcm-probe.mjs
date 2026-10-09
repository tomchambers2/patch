import { readFileSync } from 'node:fs';
const sa = JSON.parse(readFileSync('../../deploy/certs/fcm.json','utf8'));
const admin = await import('firebase-admin');
const app = admin.default.initializeApp({ credential: admin.default.credential.cert(sa) }, 'probe');
const messaging = app.messaging();
// A syntactically plausible but unregistered token.
const badToken = 'd'.repeat(140) + ':APA91bUNREGISTERED-PROBE-TOKEN';
try {
  const res = await messaging.sendEachForMulticast({
    tokens: [badToken],
    notification: { title: 'Patch', body: 'C3 probe' },
    android: { priority: 'normal' },
  });
  console.log('successCount', res.successCount, 'failureCount', res.failureCount);
  res.responses.forEach((r,i)=>console.log('resp', i, 'success', r.success, 'errorCode', r.error?.code, 'msg', r.error?.message));
} catch (e) {
  console.log('THROW', e.code, e.message);
}
process.exit(0);
