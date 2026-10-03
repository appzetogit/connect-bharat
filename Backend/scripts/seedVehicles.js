/**
 * Seed the admin vehicle catalog with the Connect Bharat fleet.
 *
 * Idempotent: matches on name, so re-running updates rather than duplicating.
 * Images point at the files already in frontend/public/vehicles.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';

const FLEET = [
  { name: 'Auto Rickshaw',        category: 'Auto',        capacity: 3, icon_types: 'auto', image: '/vehicles/auto.jpg',          short_description: 'Quick, metered short-distance autos' },
  { name: 'Maruti Suzuki Dzire',  category: 'Sedan',       capacity: 4, icon_types: 'car',  image: '/vehicles/dzire.jpg',         short_description: 'Comfortable sedan for city and airport runs' },
  { name: 'Maruti Suzuki Ertiga', category: 'MUV',         capacity: 6, icon_types: 'car',  image: '/vehicles/ertiga.jpg',        short_description: 'Spacious MUV for families and groups' },
  { name: 'Toyota Innova Crysta', category: 'Premium SUV', capacity: 6, icon_types: 'car',  image: '/vehicles/innova-crysta.jpg', short_description: 'Premium SUV for outstation travel' },
  { name: 'Toyota Fortuner',      category: 'Luxury SUV',  capacity: 7, icon_types: 'car',  image: '/vehicles/fortuner.jpg',      short_description: 'Luxury SUV for executive travel' },
];

const run = async () => {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });

  const out = [];
  for (const v of FLEET) {
    const doc = await Vehicle.findOneAndUpdate(
      { name: v.name },
      { $set: { ...v, transport_type: 'taxi', dispatch_type: 'normal', is_taxi: true, status: 1, active: true } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    out.push({ name: doc.name, category: doc.category, capacity: doc.capacity, active: doc.active });
  }

  console.log(JSON.stringify({ seeded: out.length, vehicles: out }, null, 1));
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
