// One-off pricing update requested 2026-09-03: City Ride (transport_type
// 'taxi', pricing_scope 'ride') pricing for Bangalore across 8 vehicle
// categories, including creating a new "ZI Auto + (Pet)" vehicle type.
//
// Field mapping decided with the requester:
//   - Admin Comm. (Driver) -> fixed Rs 0   (admin_commission_from_driver, type 2)
//   - Admin Comm. (Owner)  -> fixed Rs 5   (admin_commission_for_owner, type 2)
//   - The Platform/Third-Party/GST/"Total Admin Charges" breakdown has no
//     field in the schema - it is cost documentation only, not persisted.
//   - "ZI XL" applies to both Connect Bharat XL and ZI Airport XL.
//
// Usage:
//   node scripts/apply_city_ride_pricing_2026-09.js          (dry run)
//   node scripts/apply_city_ride_pricing_2026-09.js --apply  (writes changes)
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const APPLY = process.argv.includes('--apply');
const ZONE_NAME = 'Bangalore';

const COMMON = {
  admin_commission_type_from_driver: 2,
  admin_commission_from_driver: 0,
  admin_commission_type_for_owner: 2,
  admin_commission_for_owner: 5,
  service_tax: 0,
  base_distance: 1.5,
  user_cancellation_fee_type: 'fixed',
  user_cancellation_fee: 10,
  driver_cancellation_fee_type: 'fixed',
  driver_cancellation_fee: 10,
  cancellation_fee_goes_to: 'admin',
  free_waiting_before: 5,
  free_waiting_after: 5,
};

// vehicle name -> { base_price, price_per_distance, waiting_charge }
const VEHICLE_PRICES = {
  'ZI Auto': { base_price: 59, price_per_distance: 18, waiting_charge: 2 },
  'ZI Auto Fastest': { base_price: 79, price_per_distance: 18, waiting_charge: 2 },
  'ZI Auto + (Pet)': { base_price: 89, price_per_distance: 18, waiting_charge: 2 },
  'Connect Bharat AC': { base_price: 120, price_per_distance: 24, waiting_charge: 3 },
  'Connect Bharat Non-AC': { base_price: 96, price_per_distance: 20, waiting_charge: 3 },
  'Connect Bharat XL': { base_price: 165, price_per_distance: 24, waiting_charge: 5 },
  'ZI Airport XL': { base_price: 165, price_per_distance: 24, waiting_charge: 5 },
  'Connect Bharat Premium': { base_price: 140, price_per_distance: 24, waiting_charge: 5 },
};

const NEW_VEHICLE_NAME = 'ZI Auto + (Pet)';
const CLONE_TEMPLATE_VEHICLE_NAME = 'ZI Auto';

const vehicleSchema = new mongoose.Schema({}, { strict: false, collection: 'taxivehicles' });
const setPriceSchema = new mongoose.Schema({}, { strict: false, collection: 'taxisetprices' });
const zoneSchema = new mongoose.Schema({}, { strict: false, collection: 'taxizones' });
const Vehicle = mongoose.model('Vehicle_Migration', vehicleSchema);
const SetPrice = mongoose.model('SetPrice_Migration', setPriceSchema);
const Zone = mongoose.model('Zone_Migration', zoneSchema);

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME });
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const zone = await Zone.findOne({ name: ZONE_NAME }).lean();
  if (!zone) throw new Error(`Zone "${ZONE_NAME}" not found`);
  console.log(`Zone: ${zone.name} (${zone._id}), service_location_id=${zone.service_location_id}`);

  // Ensure the new vehicle type exists (idempotent).
  let newVehicle = await Vehicle.findOne({ name: NEW_VEHICLE_NAME }).lean();
  if (!newVehicle) {
    const template = await Vehicle.findOne({ name: CLONE_TEMPLATE_VEHICLE_NAME }).lean();
    if (!template) throw new Error(`Template vehicle "${CLONE_TEMPLATE_VEHICLE_NAME}" not found`);
    const doc = {
      name: NEW_VEHICLE_NAME,
      short_description: template.short_description || '',
      description: template.description || '',
      transport_type: template.transport_type,
      dispatch_type: template.dispatch_type,
      icon_types: template.icon_types,
      category: template.category,
      capacity: template.capacity,
      size: template.size || '',
      is_taxi: template.is_taxi,
      service_tax: 0,
      admin_commission_type_from_driver: 1,
      admin_commission_from_driver: 0,
      admin_commission_type_for_owner: 1,
      admin_commission_for_owner: 0,
      // Placeholder only - reused from ZI Auto since no distinct asset was
      // supplied. Replace via the admin panel's vehicle-type image upload.
      image: template.image || '',
      icon: template.icon || '',
      map_icon: template.map_icon || '',
      status: 1,
      active: true,
    };
    console.log(`\n[CREATE VEHICLE] ${NEW_VEHICLE_NAME} (cloned from ${CLONE_TEMPLATE_VEHICLE_NAME}, placeholder image)`);
    if (APPLY) {
      const created = await Vehicle.create(doc);
      newVehicle = created.toObject();
      console.log(`  -> created ${newVehicle._id}`);
    } else {
      newVehicle = { _id: '(dry-run, not yet created)', ...doc };
    }
  } else {
    console.log(`\n[VEHICLE EXISTS] ${NEW_VEHICLE_NAME} (${newVehicle._id}) - reusing`);
  }

  const backup = [];
  let createdCount = 0;
  let updatedCount = 0;

  for (const [name, prices] of Object.entries(VEHICLE_PRICES)) {
    const vehicle = name === NEW_VEHICLE_NAME ? newVehicle : await Vehicle.findOne({ name }).lean();
    if (!vehicle) {
      console.log(`\n[SKIP] Vehicle "${name}" not found - no price change made`);
      continue;
    }
    const vehicleId = vehicle._id;
    const query = {
      zone_id: zone._id,
      vehicle_type: vehicleId,
      pricing_scope: 'ride',
      transport_type: 'taxi',
    };
    const existing = APPLY || name === NEW_VEHICLE_NAME
      ? (vehicleId && mongoose.isValidObjectId(vehicleId) ? await SetPrice.find(query).lean() : [])
      : await SetPrice.find(query).lean();

    if (existing.length) {
      backup.push(...existing);
      console.log(`\n[UPDATE] ${name} (${vehicleId}) - ${existing.length} existing doc(s)`);
      for (const doc of existing) {
        console.log(`  ${doc._id}: base_price ${doc.base_price} -> ${prices.base_price}, ` +
          `price_per_distance ${doc.price_per_distance} -> ${prices.price_per_distance}, ` +
          `waiting_charge ${doc.waiting_charge} -> ${prices.waiting_charge}, ` +
          `owner_comm ${doc.admin_commission_for_owner}(${doc.admin_commission_type_for_owner}) -> 5(2), ` +
          `driver_comm ${doc.admin_commission_from_driver}(${doc.admin_commission_type_from_driver}) -> 0(2)`);
        if (APPLY) {
          await SetPrice.updateOne({ _id: doc._id }, { $set: { ...COMMON, ...prices } });
        }
        updatedCount += 1;
      }
    } else {
      console.log(`\n[CREATE] ${name} (${vehicleId}) - no existing doc for this zone`);
      const newDoc = {
        zone_id: zone._id,
        service_location_id: zone.service_location_id,
        pricing_scope: 'ride',
        transport_type: 'taxi',
        vehicle_type: vehicleId,
        package_destination: '',
        package_availability: 'available',
        package_vehicle_prices: [],
        payment_type: ['cash'],
        active: 1,
        admin_commision_type: 1,
        admin_commision: 0,
        time_price: 0,
        outstation_base_price: 0,
        outstation_base_distance: 0,
        outstation_price_per_distance: 0,
        outstation_time_price: 0,
        enable_airport_ride: false,
        enable_outstation_ride: false,
        enable_ride_sharing: false,
        enable_shared_ride: 0,
        price_per_seat: 0,
        shared_price_per_distance: 0,
        shared_cancel_fee: 0,
        order_number: 0,
        bill_status: 1,
        status: 'active',
        ...COMMON,
        ...prices,
      };
      console.log(`  base_price=${prices.base_price}, price_per_distance=${prices.price_per_distance}, waiting_charge=${prices.waiting_charge}`);
      if (APPLY) {
        const created = await SetPrice.create(newDoc);
        console.log(`  -> created ${created._id}`);
      }
      createdCount += 1;
    }
  }

  if (APPLY && backup.length) {
    const backupPath = path.resolve(__dirname, `../pricing-backup-${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`\nBacked up ${backup.length} pre-change doc(s) to ${backupPath}`);
  }

  console.log(`\nSummary: ${createdCount} to create, ${updatedCount} doc(s) to update (across vehicles with existing rows).`);
  if (!APPLY) console.log('Dry run only - rerun with --apply to write changes.');

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
