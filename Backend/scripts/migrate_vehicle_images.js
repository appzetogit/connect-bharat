/**
 * Move base64 data URIs out of taxivehicles and onto disk.
 *
 * Every admin page loads the vehicle-type list, and each document carried up to
 * three inline data URIs (image, icon, map_icon). That made the list response
 * ~11.4MB, serialised twice because listVehicleTypes also mirrors results into
 * paginator.data. Writing the images to /uploads and storing the path instead
 * leaves the documents a few hundred bytes each.
 *
 * Idempotent: fields that already hold a path or URL are skipped, so a re-run
 * after a partial failure only converts what is left.
 *
 * Run with --apply to write; without it the script only reports.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import sharp from 'sharp';

const APPLY = process.argv.includes('--apply');
const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB = process.env.MONGODB_DB_NAME || 'connect_bharat';
const UPLOAD_DIR = '/var/www/connect-bharat/Backend/uploads/vehicle-types';
const FIELDS = ['image', 'icon', 'map_icon'];

const isDataUri = (v) => typeof v === 'string' && v.startsWith('data:');

const decode = (dataUri) => {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUri);
  if (!match) return null;
  return Buffer.from(match[2], 'base64');
};

const run = async () => {
  await mongoose.connect(MONGO, { dbName: DB });
  const coll = mongoose.connection.db.collection('taxivehicles');
  const docs = await coll.find({}).toArray();

  if (APPLY) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  let converted = 0;
  let savedBytes = 0;
  let skipped = 0;

  for (const doc of docs) {
    const update = {};

    for (const field of FIELDS) {
      const value = doc[field];
      if (!isDataUri(value)) {
        if (value) skipped += 1;
        continue;
      }

      const raw = decode(value);
      if (!raw) {
        console.warn(`  ! ${doc._id} ${field}: could not decode, left as-is`);
        continue;
      }

      // Content hash keeps identical icons (icon and map_icon are usually the
      // same image) pointing at one file instead of duplicating it.
      const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
      const filename = `${hash}.webp`;
      const target = path.join(UPLOAD_DIR, filename);
      const urlPath = `/uploads/vehicle-types/${filename}`;

      let outSize = 0;
      if (APPLY) {
        if (!fs.existsSync(target)) {
          await sharp(raw).webp({ quality: 82, effort: 4 }).toFile(target);
        }
        outSize = fs.statSync(target).size;
      } else {
        outSize = (await sharp(raw).webp({ quality: 82, effort: 4 }).toBuffer()).length;
      }

      update[field] = urlPath;
      converted += 1;
      savedBytes += value.length - urlPath.length;
      console.log(
        `  ${doc.name || doc._id} ${field}: ${Math.round(value.length / 1024)}KB -> ${urlPath} (${Math.round(outSize / 1024)}KB file)`,
      );
    }

    if (APPLY && Object.keys(update).length) {
      await coll.updateOne({ _id: doc._id }, { $set: update });
    }
  }

  console.log(
    `\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${converted} field(s) converted, ${skipped} already non-base64, ` +
      `document payload reduced by ~${(savedBytes / 1048576).toFixed(2)} MB`,
  );
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
