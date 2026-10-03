import mongoose from 'mongoose';

const userAddressSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      enum: ['Home', 'Office', 'Other'],
      default: 'Home',
      index: true,
    },
    street: {
      type: String,
      required: true,
      trim: true,
    },
    additionalDetails: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    zipCode: {
      type: String,
      default: '',
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: undefined,
        validate: {
          validator: (value) =>
            value === undefined ||
            (Array.isArray(value) &&
              value.length === 2 &&
              value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))),
          message: 'location.coordinates must be [lng, lat]',
        },
      },
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { _id: true, timestamps: true },
);

const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    countryCode: {
      type: String,
      default: '+91',
      trim: true,
    },
    // The code a driver is given to start this rider's trips. Fixed per rider
    // rather than per ride, as the client asked: the same four digits every
    // time. Set on their first ride and never changed afterwards.
    //
    // Worth knowing what it trades away - a per-ride code proves the rider is
    // present, while this one only proves the driver has carried them before.
    rideOtp: {
      type: String,
      trim: true,
      minlength: 4,
      maxlength: 4,
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      minlength: 5,
      select: false,
    },
    profileImage: {
      type: String,
      default: '',
      trim: true,
    },
    governmentIdProof: {
      type: {
        type: String,
        enum: ['aadhaar', 'voter_id', 'passport', 'driving_license', 'other', ''],
        default: '',
        trim: true,
      },
      imageUrl: {
        type: String,
        default: '',
        trim: true,
      },
      backImageUrl: {
        type: String,
        default: '',
        trim: true,
      },
      fileName: {
        type: String,
        default: '',
        trim: true,
      },
      backFileName: {
        type: String,
        default: '',
        trim: true,
      },
      uploadedAt: {
        type: Date,
        default: null,
      },
      backUploadedAt: {
        type: Date,
        default: null,
      },
    },
    fcmTokenWeb: {
      type: String,
      default: '',
      trim: true,
    },
    fcmTokenMobile: {
      type: String,
      default: '',
      trim: true,
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    anniversary: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other', 'prefer-not-to-say', ''],
      default: '',
    },
    referralCode: {
      type: String,
      default: '',
      trim: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      default: null,
      index: true,
    },
    acquiredByEmployeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiEmployee',
      default: null,
      index: true,
    },
    acquiredByEmployeeCode: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
    },
    referralCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    referredRideCompletionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    referralRewardGrantedAt: {
      type: Date,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    /// Audit for isVerified: which admin verified (or un-verified) the rider,
    /// when, and why. Only written by PATCH /admin/users/:id/verify.
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    verificationNote: {
      type: String,
      default: '',
      trim: true,
    },
    /// Why the account was blocked (active:false), so support can answer the
    /// rider and the next admin doesn't unblock by accident.
    blockReason: {
      type: String,
      default: '',
      trim: true,
    },
    blockedAt: {
      type: Date,
      default: null,
    },
    blockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    role: {
      type: String,
      default: 'USER',
      trim: true,
    },
    addresses: {
      type: [userAddressSchema],
      default: [],
    },
    active: {
      type: Boolean,
      default: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletion_reason: {
      type: String,
      default: '',
      trim: true,
    },
    deletionRequest: {
      status: {
        type: String,
        enum: ['none', 'pending', 'approved', 'rejected'],
        default: 'none',
        index: true,
      },
      reason: {
        type: String,
        default: '',
        trim: true,
      },
      requestedAt: {
        type: Date,
        default: null,
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
      adminNote: {
        type: String,
        default: '',
        trim: true,
      },
    },
    currentRideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRide',
      default: null,
    },
    /// Running average of the ratings drivers gave this rider after completed
    /// trips. Kept on the user so the driver's ride card can show it without
    /// aggregating rides. Meaningless while ratingCount is 0.
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /// People SMSed when the rider presses SOS. Same shape as a driver's
    /// emergencyContacts so both apps can share one contact picker.
    emergencyContacts: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          phone: { type: String, required: true, trim: true },
          relation: { type: String, default: '', trim: true },
          source: { type: String, enum: ['manual', 'device'], default: 'manual' },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ deletedAt: 1, createdAt: -1 });
userSchema.index({ name: 1 });
userSchema.index({ email: 1 });
userSchema.index({ acquiredByEmployeeCode: 1 });
userSchema.index({ 'addresses.location': '2dsphere' });
userSchema.index({ 'deletionRequest.status': 1, deletedAt: 1 });

const UserModel = mongoose.models.TaxiUser || mongoose.model('TaxiUser', userSchema);

export const User = UserModel;
export const FoodUser = UserModel;
