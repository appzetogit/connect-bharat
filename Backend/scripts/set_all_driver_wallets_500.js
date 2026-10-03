
import mongoose from 'mongoose';

await mongoose.connect('mongodb://127.0.0.1:27017/connect_bharat');
const db = mongoose.connection.db;

const driversCol = db.collection('taxidrivers');

console.log("=== Drivers BEFORE update ===");
const before = await driversCol.find({}, { projection: { name: 1, phone: 1, status: 1, wallet: 1 } }).toArray();
for (const d of before) {
  console.log(`Driver: ${d.name} (${d.phone}) | Status: ${d.status} | Balance: ${d.wallet?.balance ?? 0}`);
}

console.log("\n=== Setting wallet.balance = 500 for ALL drivers ===");
const result = await driversCol.updateMany(
  {},
  {
    $set: {
      'wallet.balance': 500,
      'wallet.isBlocked': false,
      'wallet.updatedAt': new Date(),
    }
  }
);
console.log(`Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

console.log("\n=== Drivers AFTER update ===");
const after = await driversCol.find({}, { projection: { name: 1, phone: 1, status: 1, wallet: 1 } }).toArray();
for (const d of after) {
  console.log(`Driver: ${d.name} (${d.phone}) | Status: ${d.status} | Balance: ₹${d.wallet?.balance ?? 0}`);
}

await mongoose.disconnect();
