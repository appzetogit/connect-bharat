import mongoose from 'mongoose';

/// One physical rental car (a number plate), as opposed to a
/// `RentalVehicleType`, which is a catalogue entry. Inventory and overlap
/// checks count these.
///
/// `status` is the unit's own condition. `booked` is informational (it is out
/// right now); whether it is free for a future window is answered by the
/// booking calendar, so a `booked` unit still counts as fleet.
const unitDocumentSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    imageUrl: { type: String, default: '', trim: true },
    number: { type: String, default: '', trim: true },
    expiryDate: { type: Date, default: null },
  },
  { _id: false },
);

const rentalVehicleUnitSchema = new mongoose.Schema(
  {
    rentalVehicleTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRentalVehicleType',
      required: true,
    },
    registrationNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    serviceStoreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiServiceStore',
      default: null,
    },
    status: {
      type: String,
      enum: ['available', 'booked', 'maintenance', 'inactive'],
      default: 'available',
    },
    odometer: { type: Number, default: 0, min: 0 },
    fuel: { type: String, default: '', trim: true },
    color: { type: String, default: '', trim: true },
    modelYear: { type: Number, default: null },
    photos: { type: [String], default: [] },
    documents: { type: [unitDocumentSchema], default: [] },
    notes: { type: String, default: '', trim: true },
    currentBookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRentalBookingRequest',
      default: null,
    },
  },
  { timestamps: true },
);

rentalVehicleUnitSchema.index({ registrationNumber: 1 }, { unique: true });
rentalVehicleUnitSchema.index({ rentalVehicleTypeId: 1, serviceStoreId: 1, status: 1 });

export const RentalVehicleUnit =
  mongoose.models.TaxiRentalVehicleUnit ||
  mongoose.model('TaxiRentalVehicleUnit', rentalVehicleUnitSchema);
