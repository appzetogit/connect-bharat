import mongoose from 'mongoose';

const driverRegistrationSessionSchema = new mongoose.Schema(
  {
    registrationId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['driver', 'owner', 'bus_driver', 'service_center', 'service_center_staff'],
      default: 'driver',
    },
    roleConfirmed: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['otp_sent', 'otp_verified', 'personal_saved', 'role_details_saved', 'vehicle_saved', 'documents_saved', 'completed'],
      default: 'otp_sent',
    },
    otpHash: {
      type: String,
      required: true,
      select: false,
    },
    otpExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    otpVerifiedAt: {
      type: Date,
      default: null,
    },
    personal: {
      fullName: { type: String, default: '' },
      email: { type: String, default: '' },
      gender: { type: String, default: '' },
      passwordHash: { type: String, default: '', select: false },
    },
    referralCode: {
      type: String,
      default: '',
    },
    employeeCode: {
      type: String,
      default: '',
    },
    vehicle: {
      registerFor: { type: String, default: 'taxi' },
      serviceCategories: { type: [String], default: [] },
      locationId: { type: String, default: '' },
      locationName: { type: String, default: '' },
      vehicleTypeId: { type: String, default: '' },
      // Every category the driver ticked, in the order they picked them;
      // vehicleTypeId above is just the first of these.
      //
      // Without this field Mongoose dropped the list on save - silently, since
      // schemas are strict - so a driver who chose Connect Bharat AC and Non-AC
      // finished onboarding with one type and only ever saw that one's ride
      // requests. The apps and the dispatch matching had handled several all
      // along; the list never survived being written down.
      vehicleTypeIds: { type: [String], default: [] },
      rcNumber: { type: String, default: '' },
      make: { type: String, default: '' },
      model: { type: String, default: '' },
      year: { type: String, default: '' },
      number: { type: String, default: '' },
      color: { type: String, default: '' },
      companyName: { type: String, default: '' },
      companyAddress: { type: String, default: '' },
      city: { type: String, default: '' },
      postalCode: { type: String, default: '' },
      taxNumber: { type: String, default: '' },
      customFields: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },
    documents: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    roleDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    finalDriverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      default: null,
    },
    finalEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    finalEntityRole: {
      type: String,
      enum: ['driver', 'owner', 'bus_driver', 'service_center', 'service_center_staff', ''],
      default: '',
    },
    completedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

driverRegistrationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DriverRegistrationSession =
  mongoose.models.TaxiDriverRegistrationSession ||
  mongoose.model('TaxiDriverRegistrationSession', driverRegistrationSessionSchema);
