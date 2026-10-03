import mongoose from 'mongoose';
import { computeRentalBillingMetrics } from '../../rental/services/rentalBilling.js';

const rentalTrackingHistorySchema = new mongoose.Schema(
  {
    coordinates: {
      type: [Number],
      default: [],
    },
    capturedAt: {
      type: Date,
      default: null,
    },
    heading: {
      type: Number,
      default: null,
    },
    speed: {
      type: Number,
      default: null,
    },
    accuracyMeters: {
      type: Number,
      default: null,
    },
    zoneStatus: {
      type: String,
      default: 'unknown',
      trim: true,
    },
  },
  { _id: false },
);

const rentalTrackingAlertSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      default: '',
      trim: true,
    },
    severity: {
      type: String,
      default: 'warning',
      trim: true,
    },
    message: {
      type: String,
      default: '',
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: null,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false },
);

const rentalTrackingPointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator(value) {
          return (
            Array.isArray(value) &&
            value.length === 2 &&
            value.every((coordinate) => Number.isFinite(Number(coordinate)))
          );
        },
        message: 'rentalTracking.currentLocation.coordinates must be [lng, lat]',
      },
    },
  },
  { _id: false },
);

const inspectionPhotoMetadataSchema = new mongoose.Schema(
  {
    imageUrl: {
      type: String,
      default: '',
      trim: true,
    },
    capturedAt: {
      type: Date,
      default: null,
    },
    latitude: {
      type: Number,
      default: null,
    },
    longitude: {
      type: Number,
      default: null,
    },
    address: {
      type: String,
      default: '',
      trim: true,
    },
    source: {
      type: String,
      default: '',
      trim: true,
    },
    fileName: {
      type: String,
      default: '',
      trim: true,
    },
    mimeType: {
      type: String,
      default: '',
      trim: true,
    },
    deviceModel: {
      type: String,
      default: '',
      trim: true,
    },
    watermarkText: {
      type: String,
      default: '',
      trim: true,
    },
    exif: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false },
);

const rentalBookingRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      default: null,
    },
    bookingReference: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    vehicleTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRentalVehicleType',
      required: true,
    },
    vehicleName: {
      type: String,
      default: '',
      trim: true,
    },
    vehicleCategory: {
      type: String,
      default: '',
      trim: true,
    },
    vehicleImage: {
      type: String,
      default: '',
      trim: true,
    },
    selectedPackage: {
      packageId: {
        type: String,
        default: '',
        trim: true,
      },
      label: {
        type: String,
        default: '',
        trim: true,
      },
      durationHours: {
        type: Number,
        default: 0,
        min: 0,
      },
      price: {
        type: Number,
        default: 0,
        min: 0,
      },
      extraHourPrice: {
        type: Number,
        default: 0,
        min: 0,
      },
      /// Snapshotted at creation so a later admin edit of the vehicle's
      /// pricing never reprices a booking already made. `includedKm` and
      /// `price` are per day when `pricingUnit` is 'day'.
      pricingUnit: {
        type: String,
        enum: ['hour', 'day'],
        default: 'hour',
      },
      billedDays: {
        type: Number,
        default: 0,
        min: 0,
      },
      includedKm: {
        type: Number,
        default: 0,
        min: 0,
      },
      extraKmPrice: {
        type: Number,
        default: 0,
        min: 0,
      },
      extraDayPrice: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    serviceLocation: {
      locationId: {
        type: String,
        default: '',
        trim: true,
      },
      name: {
        type: String,
        default: '',
        trim: true,
      },
      address: {
        type: String,
        default: '',
        trim: true,
      },
      city: {
        type: String,
        default: '',
        trim: true,
      },
      latitude: {
        type: Number,
        default: null,
      },
      longitude: {
        type: Number,
        default: null,
      },
      distanceKm: {
        type: Number,
        default: null,
      },
    },
    pickupDateTime: {
      type: Date,
      required: true,
    },
    returnDateTime: {
      type: Date,
      required: true,
    },
    requestedHours: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    payableNow: {
      type: Number,
      default: 0,
      min: 0,
    },
    advancePaymentLabel: {
      type: String,
      default: '',
      trim: true,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'not_required', 'failed'],
      default: 'pending',
    },
    paymentMethod: {
      type: String,
      default: '',
      trim: true,
    },
    paymentMethodLabel: {
      type: String,
      default: '',
      trim: true,
    },
    payment: {
      provider: {
        type: String,
        default: '',
        trim: true,
      },
      status: {
        type: String,
        default: '',
        trim: true,
      },
      amount: {
        type: Number,
        default: 0,
        min: 0,
      },
      currency: {
        type: String,
        default: 'INR',
        trim: true,
      },
      orderId: {
        type: String,
        default: '',
        trim: true,
      },
      paymentId: {
        type: String,
        default: '',
        trim: true,
      },
      signature: {
        type: String,
        default: '',
        trim: true,
      },
    },
    contactName: {
      type: String,
      default: '',
      trim: true,
    },
    contactPhone: {
      type: String,
      default: '',
      trim: true,
    },
    contactEmail: {
      type: String,
      default: '',
      trim: true,
    },
    kycCompleted: {
      type: Boolean,
      default: false,
    },
    kycDocuments: {
      drivingLicense: {
        imageUrl: {
          type: String,
          default: '',
          trim: true,
        },
        fileName: {
          type: String,
          default: '',
          trim: true,
        },
        uploadedAt: {
          type: Date,
          default: null,
        },
      },
      aadhaarCard: {
        imageUrl: {
          type: String,
          default: '',
          trim: true,
        },
        fileName: {
          type: String,
          default: '',
          trim: true,
        },
        uploadedAt: {
          type: Date,
          default: null,
        },
      },
    },
    assignedVehicle: {
      vehicleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TaxiRentalVehicleType',
        default: null,
      },
      name: {
        type: String,
        default: '',
        trim: true,
      },
      vehicleCategory: {
        type: String,
        default: '',
        trim: true,
      },
      image: {
        type: String,
        default: '',
        trim: true,
      },
    },
    rentalInspection: {
      beforeHandover: {
        exteriorOk: { type: Boolean, default: false },
        interiorOk: { type: Boolean, default: false },
        dashboardOk: { type: Boolean, default: false },
        tyresOk: { type: Boolean, default: false },
        fuelOk: { type: Boolean, default: false },
        documentsOk: { type: Boolean, default: false },
      },
      afterReturn: {
        exteriorChecked: { type: Boolean, default: false },
        interiorChecked: { type: Boolean, default: false },
        dashboardChecked: { type: Boolean, default: false },
        fuelChecked: { type: Boolean, default: false },
        tyresChecked: { type: Boolean, default: false },
        damageReviewed: { type: Boolean, default: false },
      },
      pickupNotes: {
        type: String,
        default: '',
        trim: true,
      },
      returnNotes: {
        type: String,
        default: '',
        trim: true,
      },
      pickupMeterReading: {
        type: Number,
        default: null,
        min: 0,
      },
      returnMeterReading: {
        type: Number,
        default: null,
        min: 0,
      },
      pickupFuelLevel: {
        type: String,
        default: '',
        trim: true,
      },
      returnFuelLevel: {
        type: String,
        default: '',
        trim: true,
      },
      beforeConditionImages: {
        type: [String],
        default: [],
      },
      afterConditionImages: {
        type: [String],
        default: [],
      },
      beforeConditionImageDetails: {
        type: [inspectionPhotoMetadataSchema],
        default: [],
      },
      afterConditionImageDetails: {
        type: [inspectionPhotoMetadataSchema],
        default: [],
      },
    },
    serviceCenterIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'TaxiServiceStore',
      default: [],
    },
    commissionSnapshot: {
      serviceStoreId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TaxiServiceStore',
        default: null,
      },
      serviceStoreName: {
        type: String,
        default: '',
        trim: true,
      },
      ownerName: {
        type: String,
        default: '',
        trim: true,
      },
      serviceStoreCommissionType: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage',
      },
      serviceStoreCommissionValue: {
        type: Number,
        default: 0,
        min: 0,
      },
      ownerCommissionType: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage',
      },
      ownerCommissionValue: {
        type: Number,
        default: 0,
        min: 0,
      },
      serviceTaxPercentage: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    assignedStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiServiceCenterStaff',
      default: null,
    },
    assignedStaffName: {
      type: String,
      default: '',
      trim: true,
    },
    assignedStaffPhone: {
      type: String,
      default: '',
      trim: true,
    },
    serviceCenterNote: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'assigned', 'end_requested', 'completed', 'cancelled'],
      default: 'pending',
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    completionRequestedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    finalCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    finalElapsedMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      default: '',
      trim: true,
    },
    adminNote: {
      type: String,
      default: '',
      trim: true,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    // --- SOW rental completion (rental/ module) -----------------------------
    driveMode: {
      type: String,
      enum: ['self_drive', 'with_driver'],
      default: 'self_drive',
    },
    /// Driving-licence KYC applies to self-drive only.
    kycRequired: {
      type: Boolean,
      default: true,
    },
    withDriverSurcharge: {
      amount: { type: Number, default: 0, min: 0 },
      unit: {
        type: String,
        enum: ['per_booking', 'per_hour', 'per_day'],
        default: 'per_day',
      },
    },
    driverSurchargeAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /// Billing switches captured at creation, so changing a setting later
    /// never changes the price of a booking already made.
    billingTerms: {
      kmBillingEnabled: { type: Boolean, default: false },
    },
    /// The moment the rental clock stopped (first end request or completion).
    /// Final charges are recomputed against this, so late inspection data
    /// (odometer, damage) can still be billed without billing extra time.
    billingEndedAt: {
      type: Date,
      default: null,
    },
    assignedUnitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRentalVehicleUnit',
      default: null,
    },
    assignedUnitRegistration: {
      type: String,
      default: '',
      trim: true,
    },
    assignedDriverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      default: null,
    },
    assignedDriverName: {
      type: String,
      default: '',
      trim: true,
    },
    assignedDriverPhone: {
      type: String,
      default: '',
      trim: true,
    },
    deposit: {
      required: { type: Boolean, default: false },
      amount: { type: Number, default: 0, min: 0 },
      status: {
        type: String,
        enum: ['not_required', 'pending', 'held', 'partially_released', 'released', 'forfeited'],
        default: 'not_required',
      },
      paidVia: { type: String, default: '', trim: true },
      paymentId: { type: String, default: '', trim: true },
      orderId: { type: String, default: '', trim: true },
      paidAt: { type: Date, default: null },
      releasedAmount: { type: Number, default: 0, min: 0 },
      releasedAt: { type: Date, default: null },
      releasedVia: { type: String, default: '', trim: true },
      refundReference: { type: String, default: '', trim: true },
      deductions: {
        type: [
          new mongoose.Schema(
            {
              reason: { type: String, default: '', trim: true },
              amount: { type: Number, default: 0, min: 0 },
              damageReportId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'TaxiRentalDamageReport',
                default: null,
              },
              createdAt: { type: Date, default: Date.now },
            },
            { _id: true },
          ),
        ],
        default: [],
      },
    },
    extensions: {
      type: [
        new mongoose.Schema(
          {
            from: { type: Date, required: true },
            to: { type: Date, required: true },
            hours: { type: Number, default: 0, min: 0 },
            amount: { type: Number, default: 0, min: 0 },
            includedKm: { type: Number, default: 0, min: 0 },
            status: {
              type: String,
              enum: ['requested', 'approved', 'rejected', 'paid'],
              default: 'requested',
            },
            paymentId: { type: String, default: '', trim: true },
            paidVia: { type: String, default: '', trim: true },
            paidAt: { type: Date, default: null },
            autoApproved: { type: Boolean, default: false },
            note: { type: String, default: '', trim: true },
            decidedAt: { type: Date, default: null },
            decidedBy: { type: String, default: '', trim: true },
          },
          { _id: true, timestamps: true },
        ),
      ],
      default: [],
    },
    /// Charges added after the fact (damage the deposit could not cover).
    additionalCharges: {
      type: [
        new mongoose.Schema(
          {
            type: { type: String, default: 'damage', trim: true },
            reason: { type: String, default: '', trim: true },
            amount: { type: Number, default: 0, min: 0 },
            damageReportId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'TaxiRentalDamageReport',
              default: null,
            },
            createdAt: { type: Date, default: Date.now },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    damageReportIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'TaxiRentalDamageReport',
      default: [],
    },
    invoice: {
      invoiceNumber: { type: String, default: '', trim: true },
      generatedAt: { type: Date, default: null },
      emailedAt: { type: Date, default: null },
      emailStatus: { type: String, default: '', trim: true },
    },
    /// Corporate rental (7.3): stored only; the corporate module integrates.
    corporateId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    corporateEmployeeId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    billingMode: {
      type: String,
      enum: ['self', 'corporate'],
      default: 'self',
    },
    rentalTracking: {
      trackingStatus: {
        type: String,
        enum: ['inactive', 'active', 'location_off', 'tracking_stopped'],
        default: 'inactive',
      },
      zoneStatus: {
        type: String,
        enum: ['inside', 'outside', 'unknown'],
        default: 'unknown',
      },
      currentLocation: {
        type: rentalTrackingPointSchema,
        default: undefined,
      },
      lastLocationAt: {
        type: Date,
        default: null,
      },
      lastClientTimestamp: {
        type: Date,
        default: null,
      },
      lastHeading: {
        type: Number,
        default: null,
      },
      lastSpeed: {
        type: Number,
        default: null,
      },
      lastAccuracyMeters: {
        type: Number,
        default: null,
      },
      matchedZoneName: {
        type: String,
        default: '',
        trim: true,
      },
      distanceFromHubMeters: {
        type: Number,
        default: null,
      },
      geofenceRadiusMeters: {
        type: Number,
        default: null,
      },
      hubName: {
        type: String,
        default: '',
        trim: true,
      },
      history: {
        type: [rentalTrackingHistorySchema],
        default: [],
      },
      alerts: {
        type: [rentalTrackingAlertSchema],
        default: [],
      },
    },
  },
  { timestamps: true },
);

rentalBookingRequestSchema.index({ status: 1, createdAt: -1 });
rentalBookingRequestSchema.index({ userId: 1, createdAt: -1 });
rentalBookingRequestSchema.index({ vehicleTypeId: 1, createdAt: -1 });
rentalBookingRequestSchema.index({ 'rentalTracking.currentLocation': '2dsphere' });
rentalBookingRequestSchema.index({ vehicleTypeId: 1, status: 1, pickupDateTime: 1, returnDateTime: 1 });
rentalBookingRequestSchema.index({ assignedUnitId: 1, status: 1 });
rentalBookingRequestSchema.index({ corporateId: 1, createdAt: -1 });

const RENTAL_SETTLED_STATUSES = ['end_requested', 'completed'];

/// Keeps `finalCharge` true to the bill whenever a settled booking is saved.
///
/// Three code paths settle a rental (the rider ending it, the admin panel and
/// the service-centre app), and the service-centre one never computed a
/// charge at all. The odometer and damage findings also arrive after the
/// rider has ended the rental. Recomputing here, against the moment the clock
/// stopped (`billingEndedAt`), covers all of them without touching their
/// code, and never bills time after that moment.
///
/// A legacy completed booking that already has a charge and no
/// `billingEndedAt` is left exactly as it is.
rentalBookingRequestSchema.pre('save', function rentalBillingPreSave() {
  const settled = RENTAL_SETTLED_STATUSES.includes(String(this.status || ''));
  this.$locals.rentalCompletedNow =
    String(this.status || '') === 'completed' && (this.isNew || this.isModified('status'));
  this.$locals.rentalUnitRelease =
    ['completed', 'cancelled'].includes(String(this.status || '')) &&
    this.isModified('status') &&
    Boolean(this.assignedUnitId);

  if (!settled) {
    if (this.billingEndedAt) this.billingEndedAt = null;
    return;
  }

  if (!this.billingEndedAt && (this.isModified('status') || !Number(this.finalCharge || 0))) {
    this.billingEndedAt = this.completionRequestedAt || this.completedAt || new Date();
  }

  if (!this.billingEndedAt) return;

  const metrics = computeRentalBillingMetrics(this.toObject({ depopulate: false }), this.billingEndedAt);
  this.finalCharge = metrics.currentCharge;
  this.finalElapsedMinutes = metrics.elapsedMinutes;
});

/// Invoice on completion, whichever path completed it. Imported lazily so the
/// model does not pull PDF and mail code (and their imports) in at load time,
/// and run after the response so a mail problem never fails the completion.
rentalBookingRequestSchema.post('save', function rentalInvoicePostSave(doc) {
  if (doc?.$locals?.rentalUnitRelease) {
    doc.$locals.rentalUnitRelease = false;
    const snapshot = {
      _id: doc._id,
      assignedUnitId: doc.assignedUnitId,
      rentalInspection: doc.rentalInspection,
    };
    import('../../rental/services/rentalInventoryService.js')
      .then((module) => module.releaseUnitForBooking(snapshot))
      .catch((error) => console.error('[rental-unit] release failed:', error?.message || error));
  }
  if (!doc?.$locals?.rentalCompletedNow) return;
  doc.$locals.rentalCompletedNow = false;
  const bookingId = doc._id;
  setImmediate(() => {
    import('../../rental/services/rentalInvoiceService.js')
      .then((module) => module.sendRentalInvoiceOnCompletion({ bookingId }))
      .catch((error) => console.error('[rental-invoice] completion hook failed:', error?.message || error));
  });
});

export const RentalBookingRequest =
  mongoose.models.TaxiRentalBookingRequest ||
  mongoose.model('TaxiRentalBookingRequest', rentalBookingRequestSchema);
