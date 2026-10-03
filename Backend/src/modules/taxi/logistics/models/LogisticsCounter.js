import mongoose from 'mongoose';

/// Atomic per-key sequences (AWB per city per day, manifest per hub per
/// day). `$inc` on a single document is atomic, so two bookings in the same
/// millisecond still get different numbers.
const logisticsCounterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const LogisticsCounter =
  mongoose.models.LogisticsCounter || mongoose.model('LogisticsCounter', logisticsCounterSchema);

export const nextSequence = async (key) => {
  const counter = await LogisticsCounter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  return counter.seq;
};
