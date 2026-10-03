/**
 * Seed (or reset) a superadmin account.
 *
 * Reads the credentials from the environment rather than hardcoding them, so a
 * password never lands in the repository — unlike scripts/seedAdmin.js, which
 * still carries admin@admin.com / 123456 in plain text.
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/seedConnectBharatAdmin.js
 *   ADMIN_NAME='Connect Bharat Admin' ...            (optional, defaults below)
 *
 * Re-running against an existing email resets that account's password rather
 * than creating a duplicate.
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGODB_DB_NAME || 'appzeto_taxi';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Connect Bharat Admin';

if (!MONGO_URI) {
  console.error('MONGODB_URI is not set');
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be provided in the environment');
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 5) {
  console.error('Password must be at least 5 characters (the model enforces this)');
  process.exit(1);
}

const adminSchema = new mongoose.Schema({}, { strict: false, collection: 'taxiadmins' });
const Admin = mongoose.model('AdminSeed', adminSchema);

const run = async () => {
  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });

  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const existing = await Admin.findOne({ email: ADMIN_EMAIL }).lean();

  if (existing) {
    await Admin.updateOne(
      { email: ADMIN_EMAIL },
      { $set: { password: hashedPassword, name: ADMIN_NAME, active: true, status: 'active' } },
    );
    console.log(`Reset the password for the existing account ${ADMIN_EMAIL} (${existing._id}).`);
  } else {
    const created = await Admin.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: hashedPassword,
      role: 'superadmin',
      admin_type: 'superadmin',
      permissions: [],
      active: true,
      status: 'active',
    });
    console.log(`Created superadmin ${ADMIN_EMAIL} (${created._id}).`);
  }

  const all = await Admin.find({}, { email: 1, admin_type: 1, active: 1 }).lean();
  console.log('\nAdmin accounts now:');
  for (const a of all) {
    console.log(`  ${a.email} | ${a.admin_type || 'superadmin'} | active=${a.active !== false}`);
  }

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
