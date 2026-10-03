// One-off pricing update requested 2026-09-05: ZI Parcel (intracity) pricing.
//
// Parcel fares are computed in deliveryService.computeDeliveryFareBreakdown
// from vehicle.delivery_distance_pricing - NOT from taxisetprices. The formula
// is:  base_price + max(distanceKm - free_distance, 0) * distance_price, then
// service tax. So base_price IS the minimum fare for any trip inside
// free_distance.
//
// There is no handling-charge field in the schema, and the requester noted
// handling is included in the Total Minimum Fare - so base_price is set to the
// Total Minimum Fare (base fare + handling), which charges exactly the intended
// amount. free_time/time_price are written to record the requested waiting
// terms, but the fare calculation currently ignores both.
//
// Usage:
//   node apply_parcel_pricing.js          (dry run)
//   node apply_parcel_pricing.js --apply  (writes changes)
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: '/var/www/connect-bharat/Backend/.env' });

const APPLY = process.argv.includes('--apply');

const BASE_DISTANCE_KM = 1.5;
const FREE_WAIT_MINUTES = 5;

// name -> requested figures
const TARGETS = {
  'ZI bike Parcel': { baseFare: 59, handling: 15, perKm: 15, waitPerMin: 1 },
  'ZI Auto Parcel': { baseFare: 93, handling: 36, perKm: 18, waitPerMin: 1 },
  'ZI Mini Truck': { baseFare: 267, handling: 50, perKm: 25, waitPerMin: 3 },
};

const vehicleSchema = new mongoose.Schema({}, { strict: false, collection: 'taxivehicles' });
const Vehicle = mongoose.model('Vehicle_ParcelPricing', vehicleSchema);

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME });
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const backup = [];
  let changed = 0;

  for (const [name, spec] of Object.entries(TARGETS)) {
    const vehicle = await Vehicle.findOne({ name }).lean();
    if (!vehicle) {
      console.log(`[SKIP] Vehicle "${name}" not found`);
      continue;
    }

    const minimumFare = spec.baseFare + spec.handling;
    const before = vehicle.delivery_distance_pricing || {};
    const after = {
      enabled: true,
      // Handling folded in: minimum fare = base fare + handling charge.
      base_price: minimumFare,
      free_distance: BASE_DISTANCE_KM,
      distance_price: spec.perKm,
      // Recorded for when waiting support lands; ignored by the fare calc today.
      free_time: FREE_WAIT_MINUTES,
      time_price: spec.waitPerMin,
    };

    console.log(`[UPDATE] ${name} (${vehicle._id})`);
    console.log(`  base_price    ${before.base_price ?? '-'} -> ${after.base_price}  (= ${spec.baseFare} base + ${spec.handling} handling)`);
    console.log(`  free_distance ${before.free_distance ?? '-'} -> ${after.free_distance} km`);
    console.log(`  distance_price ${before.distance_price ?? '-'} -> ${after.distance_price} /km`);
    console.log(`  free_time     ${before.free_time ?? '-'} -> ${after.free_time} min   (not yet used by fare calc)`);
    console.log(`  time_price    ${before.time_price ?? '-'} -> ${after.time_price} /min (not yet used by fare calc)`);
    console.log(`  enabled       ${before.enabled ?? '-'} -> true`);

    backup.push({ _id: vehicle._id, name, delivery_distance_pricing: before });

    if (APPLY) {
      await Vehicle.updateOne({ _id: vehicle._id }, { $set: { delivery_distance_pricing: after } });
    }
    changed += 1;
    console.log('');
  }

  if (APPLY && backup.length) {
    const backupPath = `/var/www/connect-bharat/Backend/parcel-pricing-backup-${Date.now()}.json`;
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`Backed up ${backup.length} pre-change record(s) to ${backupPath}`);
  }

  console.log(`\nSummary: ${changed} vehicle(s) ${APPLY ? 'updated' : 'to update'}.`);
  if (!APPLY) console.log('Dry run only - rerun with --apply to write changes.');

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
