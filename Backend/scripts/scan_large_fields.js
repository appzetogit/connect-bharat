
import mongoose from 'mongoose';

await mongoose.connect('mongodb://127.0.0.1:27017/connect_bharat');

const db = mongoose.connection.db;
const collections = await db.listCollections().toArray();

console.log(`Scanning ${collections.length} collections for oversized/base64 fields...`);

for (const col of collections) {
  const cName = col.name;
  if (cName.startsWith('system.')) continue;

  const collection = db.collection(cName);
  const sample = await collection.find({}).limit(50).toArray();

  for (const doc of sample) {
    for (const [key, val] of Object.entries(doc)) {
      if (typeof val === 'string' && (val.startsWith('data:image') || val.length > 50000)) {
        console.log(`[ALERT] ${cName} -> doc ID: ${doc._id}, field '${key}': size ${val.length} chars (starts with ${val.slice(0, 30)}...)`);
      }
    }
  }
}

await mongoose.disconnect();
console.log('Scan completed.');
