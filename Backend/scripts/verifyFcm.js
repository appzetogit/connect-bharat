/**
 * Live check of the FCM token-save routes.
 *
 * Creates throwaway user + driver records, mints tokens with the app's own
 * signer, calls the public HTTPS endpoints, re-reads the documents to confirm
 * the token actually persisted to the right field, then deletes the throwaways.
 *
 * Usage: node scripts/verifyFcm.js https://bharat.buytogetherindia.com
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { signAccessToken } from '../src/modules/taxi/services/tokenService.js';
import { User } from '../src/modules/taxi/user/models/User.js';
import { Driver } from '../src/modules/taxi/driver/models/Driver.js';

const BASE = (process.argv[2] || 'https://bharat.buytogetherindia.com').replace(/\/$/, '');
const STAMP = `fcmcheck-${Date.now()}`;
const results = [];

const call = async (path, token, body) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
};

const run = async () => {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });

  // ---- throwaway records -------------------------------------------------
  const user = await User.create({ name: STAMP, phone: `9${Date.now().toString().slice(-9)}` });
  // Driver requires vehicleType (enum bike|auto|car) and password
  const driver = await Driver.create({
    name: STAMP,
    phone: `8${Date.now().toString().slice(-9)}`,
    password: 'throwaway-not-a-real-account',
    vehicleType: 'car',
  });

  const userJwt = signAccessToken({ sub: String(user._id), role: 'user' });
  const driverJwt = signAccessToken({ sub: String(driver._id), role: 'driver' });

  const MOBILE = `mobile-token-${'x'.repeat(40)}`;
  const WEB = `web-token-${'y'.repeat(40)}`;

  // ---- user: mobile then web --------------------------------------------
  for (const [platform, token, field] of [
    ['android', MOBILE, 'fcmTokenMobile'],
    ['web', WEB, 'fcmTokenWeb'],
  ]) {
    const r = await call('/users/fcm-token', userJwt, { token, platform });
    const fresh = await User.findById(user._id).select('+fcmTokenMobile +fcmTokenWeb');
    results.push({
      route: 'POST /api/v1/users/fcm-token',
      platform,
      http: r.status,
      apiField: r.json?.data?.field,
      persisted: fresh?.[field] === token,
    });
  }

  // ---- driver: mobile then web ------------------------------------------
  for (const [platform, token, field] of [
    ['ios', MOBILE, 'fcmTokenMobile'],
    ['web', WEB, 'fcmTokenWeb'],
  ]) {
    const r = await call('/drivers/fcm-token', driverJwt, { token, platform });
    const fresh = await Driver.findById(driver._id).select('+fcmTokenMobile +fcmTokenWeb');
    results.push({
      route: 'POST /api/v1/drivers/fcm-token',
      platform,
      http: r.status,
      apiField: r.json?.data?.field,
      persisted: fresh?.[field] === token,
    });
  }

  // ---- validation + auth must be enforced --------------------------------
  const bad = await call('/users/fcm-token', userJwt, { token: 'short', platform: 'web' });
  const badPlat = await call('/users/fcm-token', userJwt, { token: WEB, platform: 'nintendo' });
  const noAuth = await fetch(`${BASE}/api/v1/users/fcm-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: WEB, platform: 'web' }),
  });

  results.push({ route: 'short token rejected', http: bad.status, expect: 400 });
  results.push({ route: 'bad platform rejected', http: badPlat.status, expect: 400 });
  results.push({ route: 'no auth rejected', http: noAuth.status, expect: 401 });

  // ---- cleanup -----------------------------------------------------------
  await User.deleteOne({ _id: user._id });
  await Driver.deleteOne({ _id: driver._id });
  const leftovers = (await User.countDocuments({ name: STAMP })) + (await Driver.countDocuments({ name: STAMP }));

  console.log(JSON.stringify({ base: BASE, results, throwawaysRemaining: leftovers }, null, 1));
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error('verify failed:', e.message);
  process.exit(1);
});
