
import mongoose from 'mongoose';

await mongoose.connect('mongodb://127.0.0.1:27017/connect_bharat');
const db = mongoose.connection.db;
const vehicles = db.collection('taxivehicles');

const docs = await vehicles.find({}).toArray();
for (const v of docs) {
  let img = v.image;
  if (img && (img.endsWith('.png') || img.endsWith('.jpg') || img.endsWith('.jpeg'))) {
    const webpUrl = img.replace(/\.(png|jpg|jpeg)$/, '.webp');
    await vehicles.updateOne({ _id: v._id }, { $set: { image: webpUrl, icon: webpUrl } });
    console.log(`Updated ${v.name} to ${webpUrl}`);
  }
}

await mongoose.disconnect();
console.log('Updated vehicle URLs to .webp in MongoDB');
