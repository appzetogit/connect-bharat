
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const uploadDir = '/var/www/connect-bharat/Backend/uploads/vehicles';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

await mongoose.connect('mongodb://127.0.0.1:27017/connect_bharat');

const vehicleSchema = new mongoose.Schema({}, { strict: false });
const Vehicle = mongoose.model('Vehicle', vehicleSchema, 'taxivehicles');

const docs = await Vehicle.find({});
console.log(`Checking ${docs.length} vehicles for base64 images...`);

for (const doc of docs) {
  const img = doc.get('image');
  const name = doc.get('name');
  const id = doc._id.toString();

  if (typeof img === 'string' && img.startsWith('data:image')) {
    console.log(`Found base64 image on vehicle: ${name} (${id})`);
    const match = img.match(/^data:image\/(\w+);base64,(.+)$/s);
    if (match) {
      let ext = match[1];
      if (ext === 'jpeg') ext = 'jpg';
      const b64Data = match[2];
      const buffer = Buffer.from(b64Data, 'base64');
      const filename = `vehicle-${id}.${ext}`;
      const filePath = path.join(uploadDir, filename);

      fs.writeFileSync(filePath, buffer);
      console.log(`Wrote ${filePath} (${buffer.length} bytes)`);

      const fileUrl = `https://bharat.buytogetherindia.com/uploads/vehicles/${filename}`;
      doc.set('image', fileUrl);
      doc.set('icon', fileUrl);
      await doc.save();
      console.log(`Updated vehicle ${name} image to ${fileUrl}`);
    }
  }
}

await mongoose.disconnect();
console.log('Done optimizing vehicles!');
