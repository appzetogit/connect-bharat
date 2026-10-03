import crypto from 'node:crypto';
import { ApiError } from '../../../../utils/ApiError.js';
import { sendOtpSms } from '../../services/smsService.js';
import { Shipment } from '../models/Shipment.js';
import { getLogisticsSettings, settingNumber } from './logisticsSettingsService.js';

/// The 4-digit code the receiver reads out to whoever hands over the parcel.
///
/// Stored only as a hash (salted with the AWB, so the same code on two
/// shipments hashes differently), sent by SMS when the shipment goes out for
/// delivery, and checked with an attempt limit so it cannot be guessed at
/// the door. A new out-for-delivery run issues a new code.
const hashDeliveryOtp = (awb, otp) =>
  crypto.createHash('sha256').update(`${String(awb)}:${String(otp).trim()}`).digest('hex');

const generateOtp = () => String(crypto.randomInt(1000, 10000));

export const issueDeliveryOtp = async (shipment) => {
  const otp = generateOtp();
  await Shipment.updateOne(
    { _id: shipment._id },
    {
      $set: {
        'deliveryOtp.hash': hashDeliveryOtp(shipment.awb, otp),
        'deliveryOtp.sentAt': new Date(),
        'deliveryOtp.attempts': 0,
        'deliveryOtp.verifiedAt': null,
        'proofOfDelivery.otpVerified': false,
      },
    },
  );

  let sms = { mode: 'skipped' };
  try {
    // The only SMS template registered with DLT is the OTP template, so the
    // receiver gets the code in that wording. A dedicated "your parcel is
    // out for delivery" template needs registering before it can be used.
    sms = await sendOtpSms({ phone: shipment.receiver?.phone, otp, purpose: 'parcel delivery OTP' });
  } catch (error) {
    console.warn('[logistics] delivery OTP SMS failed for', shipment.awb, error?.message || error);
    sms = { mode: 'failed', message: error?.message || 'SMS failed' };
  }

  return {
    sms: sms.mode,
    // Same convention as the login OTP: visible outside production only.
    debugOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
  };
};

export const verifyDeliveryOtp = async ({ shipmentId, otp }) => {
  const settings = await getLogisticsSettings();
  const maxAttempts = Math.max(1, settingNumber(settings, 'delivery_otp_max_attempts', 5));
  const shipment = await Shipment.findById(shipmentId).select('+deliveryOtp.hash');
  if (!shipment) throw new ApiError(404, 'Shipment not found');
  if (shipment.deliveryOtp?.verifiedAt) return { verified: true, alreadyVerified: true };
  if (!shipment.deliveryOtp?.hash) throw new ApiError(409, 'No delivery OTP has been issued for this shipment');
  if ((shipment.deliveryOtp.attempts || 0) >= maxAttempts) {
    throw new ApiError(429, 'Too many wrong OTP attempts. Ask the hub to resend the OTP.');
  }
  if (!/^\d{4}$/.test(String(otp || '').trim())) {
    throw new ApiError(400, 'A valid 4-digit OTP is required');
  }

  const matches = hashDeliveryOtp(shipment.awb, otp) === shipment.deliveryOtp.hash;
  if (!matches) {
    const updated = await Shipment.findOneAndUpdate(
      { _id: shipment._id },
      { $inc: { 'deliveryOtp.attempts': 1 } },
      { returnDocument: 'after' },
    );
    const left = Math.max(0, maxAttempts - (updated?.deliveryOtp?.attempts || 0));
    throw new ApiError(401, `Invalid delivery OTP. ${left} attempt(s) left.`);
  }

  await Shipment.updateOne(
    { _id: shipment._id },
    { $set: { 'deliveryOtp.verifiedAt': new Date(), 'proofOfDelivery.otpVerified': true } },
  );
  return { verified: true };
};
