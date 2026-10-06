/**
 * Launch data for Bhubaneswar and Indore: service locations, zones, the
 * vehicle catalog, City Ride prices for every vehicle in both zones, and the
 * driver daily-pass subscription plans.
 *
 * Safe to re-run: every write is an upsert matched by name (vehicles,
 * service locations, zones) or by zone + vehicle + transport (prices), and
 * nothing is ever deleted. Prices are only written on first insert unless
 * --overwrite-prices is given, so an admin's later edits in Set Prices survive
 * a re-run.
 *
 * Rates follow the client's Bangalore City Ride sheet (2026-09) where it has a
 * matching category: Auto 59 + 18/km, AC sedan 120 + 24/km, XL 165 + 24/km,
 * Premium 140 + 24/km, 1.5 km included, 5 min free waiting. Bike, E-Rickshaw
 * and Luxury SUV have no row on that sheet and use starter values below.
 *
 * Usage (from Backend/, reads .env):
 *   node scripts/seedLaunchCities.js                    (dry run, prints the plan)
 *   node scripts/seedLaunchCities.js --apply            (writes)
 *   node scripts/seedLaunchCities.js --apply --overwrite-prices
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Vehicle } from '../src/modules/taxi/admin/models/Vehicle.js';
import { ServiceLocation } from '../src/modules/taxi/admin/models/ServiceLocation.js';
import { SetPrice } from '../src/modules/taxi/admin/models/SetPrice.js';
import { TaxiAppModule } from '../src/modules/taxi/admin/models/TaxiAppModule.js';
import { Zone } from '../src/modules/taxi/driver/models/Zone.js';
import { SubscriptionPlan } from '../src/modules/taxi/admin/models/SubscriptionPlan.js';

const APPLY = process.argv.includes('--apply');
const OVERWRITE_PRICES = process.argv.includes('--overwrite-prices');

// Square zone around the city centre. 0.15 deg is ~16.5 km each way, which
// takes in the city and its near suburbs; redraw it in the admin panel to the
// real service boundary when one is agreed.
const ZONE_HALF_SIDE_DEG = 0.15;

const CITIES = [
  { name: 'Bhubaneswar', lat: 20.2961, lng: 85.8245 },
  { name: 'Indore', lat: 22.7196, lng: 75.8577 },
];

// `modules` are TaxiAppModule names; a vehicle is offered under those modules.
//
// `category` must be one of Bike / Auto / Car: it is the vehicle *class* that
// driver subscription plans and the joining bonus (bike 100, auto 100, car
// 150) match on, so a descriptive value like "Sedan" would leave car drivers
// with no plan to buy - and a pass is mandatory to receive rides.
const FLEET = [
  { name: 'Bike', category: 'Bike', capacity: 1, icon_types: 'bike', image: '/1_Bike.png', short_description: 'Fastest way through city traffic', modules: ['Bike Taxi'] },
  { name: 'Auto Rickshaw', category: 'Auto', capacity: 3, icon_types: 'auto', image: '/vehicles/auto.jpg', short_description: 'Quick, metered short-distance autos', modules: ['Auto'] },
  { name: 'E-Rickshaw', category: 'Auto', capacity: 4, icon_types: 'auto', image: '/3_E-Rickshaw.png', short_description: 'Electric, quiet and affordable', modules: ['E-Rickshaw'] },
  { name: 'Maruti Suzuki Dzire', category: 'Car', capacity: 4, icon_types: 'car', image: '/vehicles/dzire.jpg', short_description: 'Comfortable AC sedan for city and airport runs', modules: ['Taxi', 'Outstation'] },
  { name: 'Maruti Suzuki Ertiga', category: 'Car', capacity: 6, icon_types: 'car', image: '/vehicles/ertiga.jpg', short_description: 'Spacious MUV for families and groups', modules: ['Taxi', 'Outstation'] },
  { name: 'Toyota Innova Crysta', category: 'Car', capacity: 6, icon_types: 'car', image: '/vehicles/innova-crysta.jpg', short_description: 'Premium SUV for outstation travel', modules: ['Taxi', 'Outstation'] },
  { name: 'Toyota Fortuner', category: 'Car', capacity: 7, icon_types: 'car', image: '/vehicles/fortuner.jpg', short_description: 'Luxury SUV for executive travel', modules: ['Taxi', 'Outstation'] },
];

// vehicle name -> City Ride rates
const PRICES = {
  Bike: { base_price: 30, price_per_distance: 8, waiting_charge: 1 },
  'Auto Rickshaw': { base_price: 59, price_per_distance: 18, waiting_charge: 2 },
  'E-Rickshaw': { base_price: 49, price_per_distance: 15, waiting_charge: 2 },
  'Maruti Suzuki Dzire': { base_price: 120, price_per_distance: 24, waiting_charge: 3 },
  'Maruti Suzuki Ertiga': { base_price: 165, price_per_distance: 24, waiting_charge: 5 },
  'Toyota Innova Crysta': { base_price: 140, price_per_distance: 24, waiting_charge: 5 },
  'Toyota Fortuner': { base_price: 200, price_per_distance: 30, waiting_charge: 5 },
};

// Shared terms, as on the client's Bangalore sheet: no driver commission,
// fixed Rs 5 for owners, Rs 10 cancellation fee to admin.
const COMMON_PRICE_TERMS = {
  pricing_scope: 'ride',
  base_distance: 1.5,
  time_price: 0,
  service_tax: 0,
  free_waiting_before: 5,
  free_waiting_after: 5,
  payment_type: ['cash', 'online', 'wallet'],
  admin_commission_type_from_driver: 2,
  admin_commission_from_driver: 0,
  admin_commission_type_for_owner: 2,
  admin_commission_for_owner: 5,
  admin_commision_type: 1,
  admin_commision: 0,
  user_cancellation_fee_type: 'fixed',
  user_cancellation_fee: 10,
  driver_cancellation_fee_type: 'fixed',
  driver_cancellation_fee: 10,
  cancellation_fee_goes_to: 'admin',
  active: 1,
  status: 'active',
};

// Driver daily passes. A pass is mandatory to receive rides
// (driverSubscriptionService), runs from 6am to 6am IST, and waives the
// per-trip commission while active. Matched by name; the price is only set on
// first insert so an admin's later change survives a re-run.
const PASS_HOW_IT_WORKS = 'Buy once a day from your wallet or online. Valid until 6am the next day. No commission is taken on your trips while the pass is active.';
const DRIVER_PLANS = [
  { name: 'Daily Pass - Bike & Auto', description: 'Unlimited rides for the day on a bike, auto or e-rickshaw.', amount: 29, vehicle_classes: ['bike', 'auto'] },
  { name: 'Daily Pass - Car', description: 'Unlimited rides for the day on any car.', amount: 49, vehicle_classes: ['car'] },
];

const squareAround =({ lat, lng }) => {
  const d = ZONE_HALF_SIDE_DEG;
  return {
    type: 'Polygon',
    coordinates: [[
      [lng - d, lat - d],
      [lng + d, lat - d],
      [lng + d, lat + d],
      [lng - d, lat + d],
      [lng - d, lat - d],
    ]],
  };
};

const plan = [];
const note = (line) => plan.push(line);

const upsert = async (Model, filter, update, label) => {
  const existing = await Model.findOne(filter).lean();
  note(`${existing ? 'update' : 'create'} ${label}`);
  if (!APPLY) return existing || { _id: new mongoose.Types.ObjectId(), ...filter };
  return Model.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
};

const run = async () => {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  note(`database: ${env.mongoDbName} | mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${OVERWRITE_PRICES ? ' (overwrite prices)' : ''}`);

  const modules = await TaxiAppModule.find().select('name').lean();
  const moduleIdByName = new Map(modules.map((m) => [m.name, String(m._id)]));

  const vehicles = [];
  for (const { modules: moduleNames, ...v } of FLEET) {
    const appModules = moduleNames.map((name) => moduleIdByName.get(name)).filter(Boolean);
    const missing = moduleNames.filter((name) => !moduleIdByName.has(name));
    if (missing.length) note(`  ! ${v.name}: app module(s) not found: ${missing.join(', ')}`);
    const doc = await upsert(
      Vehicle,
      { name: v.name },
      { $set: { ...v, app_modules: appModules, transport_type: 'taxi', dispatch_type: 'normal', is_taxi: true, status: 1, active: true } },
      `vehicle ${v.name}`,
    );
    vehicles.push(doc);
  }

  for (const city of CITIES) {
    const location = await upsert(
      ServiceLocation,
      { name: city.name },
      {
        $set: { name: city.name, service_location_name: city.name, active: true, status: 'active' },
        $setOnInsert: {
          currency_name: 'Indian Rupee',
          currency_code: 'INR',
          currency_symbol: '₹',
          timezone: 'Asia/Kolkata',
          latitude: city.lat,
          longitude: city.lng,
          location: { type: 'Point', coordinates: [city.lng, city.lat] },
        },
      },
      `service location ${city.name}`,
    );

    const zone = await upsert(
      Zone,
      { name: city.name },
      {
        $set: { name: city.name, service_location_id: location._id, active: true, status: 'active' },
        // The boundary is only drawn on first insert, so a zone redrawn in the
        // admin panel is never reset by a re-run.
        $setOnInsert: { unit: 'km', geometry: squareAround(city) },
      },
      `zone ${city.name}`,
    );

    for (const vehicle of vehicles) {
      const rates = PRICES[vehicle.name];
      if (!rates) continue;
      const priceFields = { ...COMMON_PRICE_TERMS, ...rates, minimum_fare: rates.base_price };
      await upsert(
        SetPrice,
        { zone_id: zone._id, vehicle_type: vehicle._id, transport_type: 'taxi', pricing_scope: 'ride' },
        {
          $set: { zone_id: zone._id, service_location_id: location._id, vehicle_type: vehicle._id, transport_type: 'taxi', ...(OVERWRITE_PRICES ? priceFields : {}) },
          ...(OVERWRITE_PRICES ? {} : { $setOnInsert: priceFields }),
        },
        `price ${city.name} / ${vehicle.name}: ${rates.base_price} + ${rates.price_per_distance}/km`,
      );
    }
  }

  for (const p of DRIVER_PLANS) {
    await upsert(
      SubscriptionPlan,
      { audience: 'driver', name: p.name },
      {
        $set: { audience: 'driver', name: p.name, description: p.description, vehicle_classes: p.vehicle_classes, how_it_works: PASS_HOW_IT_WORKS, transport_type: 'taxi', benefit_type: 'standard', active: true },
        $setOnInsert: { amount: p.amount, duration: 1 },
      },
      `driver plan ${p.name}: Rs ${p.amount}/day for ${p.vehicle_classes.join(', ')}`,
    );
  }

  console.log(plan.join('\n'));
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('seed failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
