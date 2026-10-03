import mongoose from 'mongoose';
import { RIDE_LIVE_STATUS, RIDE_STATUS } from '../../constants/index.js';

const deliverySchema = new mongoose.Schema(
  {
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRide',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      default: null,
    },
    vehicleTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiVehicle',
      default: null,
    },
    vehicleIconType: {
      type: String,
      default: '',
      trim: true,
    },
    vehicleIconUrl: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(RIDE_STATUS),
      default: RIDE_STATUS.SEARCHING,
    },
    liveStatus: {
      type: String,
      enum: Object.values(RIDE_LIVE_STATUS),
      default: RIDE_LIVE_STATUS.SEARCHING,
    },
    pickupLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    pickupAddress: {
      type: String,
      default: '',
      trim: true,
    },
    dropLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    dropAddress: {
      type: String,
      default: '',
      trim: true,
    },
    fare: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'online'],
      default: 'cash',
      lowercase: true,
      trim: true,
    },
    parcel: {
      category: {
        type: String,
        default: '',
        trim: true,
      },
      weight: {
        type: String,
        default: '',
        trim: true,
      },
      description: {
        type: String,
        default: '',
        trim: true,
      },
      deliveryCategory: {
        type: String,
        default: '',
        trim: true,
      },
      goodsTypeFor: {
        type: String,
        default: '',
        trim: true,
      },
      deliveryScope: {
        type: String,
        enum: ['city', 'outstation'],
        default: 'city',
        lowercase: true,
        trim: true,
      },
      isOutstation: {
        type: Boolean,
        default: false,
      },
      senderName: {
        type: String,
        default: '',
        trim: true,
      },
      senderMobile: {
        type: String,
        default: '',
        trim: true,
      },
      receiverName: {
        type: String,
        default: '',
        trim: true,
      },
      receiverMobile: {
        type: String,
        default: '',
        trim: true,
      },
      /// Photos of the parcel taken by the sender when booking. The app caps
      /// this at two; they are upload URLs rather than inline data so that ride
      /// documents stay small.
      photos: {
        type: [String],
        default: [],
      },
      /// Handling notes from the sender ('fragile', 'call before arriving').
      /// Separate from `description`, which names what is inside.
      instructions: {
        type: String,
        default: '',
        trim: true,
      },
      /// Proof the driver collected the parcel. Without it the trip cannot
      /// start -- see `assertParcelProof` in rideService.
      pickupProof: {
        url: { type: String, default: '' },
        at: { type: Date, default: null },
      },
      /// Proof the driver handed it over. Without it the trip cannot complete.
      deliveryProof: {
        url: { type: String, default: '' },
        at: { type: Date, default: null },
      },
      /// SOW parcel fields. Priced (behind delivery.enable_parcel_surcharges)
      /// by deliveryService; the insurance premium is always server-computed.
      weightKg: { type: Number, default: null },
      dimensions: {
        l: { type: Number, default: 0 },
        w: { type: Number, default: 0 },
        h: { type: Number, default: 0 },
      },
      fragile: { type: Boolean, default: false },
      express: { type: Boolean, default: false },
      declaredValue: { type: Number, default: 0 },
      insurance: {
        opted: { type: Boolean, default: false },
        premium: { type: Number, default: 0 },
        coverAmount: { type: Number, default: 0 },
      },
      /// Set only on rides the hub network dispatches as a shipment's first or
      /// last mile (logistics/services/legDispatchService.js).
      shipmentAwb: { type: String, default: '' },
      shipmentId: { type: String, default: '' },
      shipmentLegId: { type: String, default: '' },
      hubLegType: { type: String, default: '' },
    },
    waitingMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    waitingCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export const Delivery = mongoose.models.Delivery || mongoose.model('Delivery', deliverySchema);
