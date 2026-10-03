import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../../driver/models/Driver.js';
import { DriverNeededDocument } from '../models/DriverNeededDocument.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { emitToDriverRoom } from './adminFeedService.js';
import { assertObjectId, assertServiceLocationScope } from './operationsAccess.js';
import { getOperationsGates } from './operationsSettings.js';

/// Per-document review of a driver's uploads.
///
/// `Driver.documents` is a Mixed map keyed by upload field (aadharFront,
/// drivingLicense, ...). Each value is an object with the file URLs; review
/// state is written onto that same object as reviewStatus / reviewReason /
/// reviewedBy / reviewedAt, so the existing admin and driver screens that
/// already read `documents` see it without a second request. The names are
/// deliberately distinct from the DL/RC third-party `verification*` fields.
///
/// Must not import adminService: adminService imports this module for the
/// approval guard.

export const DOCUMENT_REVIEW_STATUSES = Object.freeze(['approved', 'rejected']);

const isDocumentTemplate = (template = {}) => {
  const type = String(template?.template_type || '').trim().toLowerCase();
  return !type || type === 'document';
};

/// Which account types a driver's documents come from. Mirrors the onboarding
/// rule: an independent driver uploads `individual` documents, a driver
/// attached to a fleet owner uploads `fleet_drivers` ones, and `both` applies
/// to everyone.
export const documentAccountTypesForDriver = (driver = {}) =>
  driver?.owner_id ? ['fleet_drivers', 'both'] : ['individual', 'both'];

/// Upload keys an admin must approve before the driver can be approved.
///
/// Same reading of the templates as buildDriverDocumentFields in adminService:
/// a front/back document contributes both sides, anything else its single key,
/// and `is_required` absent counts as required.
export const computeRequiredDocumentKeys = (templates = [], accountTypes = ['individual', 'both']) => {
  const keys = [];
  for (const template of templates) {
    if (!template || template.active === false || !isDocumentTemplate(template)) continue;
    if (template.is_required === false) continue;
    const accountType = String(template.account_type || 'individual').trim().toLowerCase();
    if (!accountTypes.includes(accountType)) continue;

    const candidateKeys = template.image_type === 'front_back'
      ? [template.front_key, template.back_key]
      : [template.key];
    for (const key of candidateKeys) {
      const normalized = String(key || '').trim();
      if (normalized && !keys.includes(normalized)) keys.push(normalized);
    }
  }
  return keys;
};

const isUploaded = (value) => {
  if (!value) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  return Boolean(value.secureUrl || value.previewUrl || value.url || value.imageUrl || value.uploaded === true);
};

export const getDocumentReviewStatus = (value) => {
  if (!value || typeof value !== 'object') return 'pending';
  const status = String(value.reviewStatus || '').trim().toLowerCase();
  return DOCUMENT_REVIEW_STATUSES.includes(status) ? status : 'pending';
};

/// Where each required document stands. Pure, so it is unit-tested.
export const summarizeDocumentReview = (documents = {}, requiredKeys = []) => {
  const safeDocuments = documents && typeof documents === 'object' ? documents : {};
  const required = requiredKeys.map((key) => {
    const value = safeDocuments[key];
    return {
      key,
      uploaded: isUploaded(value),
      reviewStatus: getDocumentReviewStatus(value),
      reviewReason: (value && typeof value === 'object' && value.reviewReason) || '',
    };
  });

  const missing = required.filter((item) => !item.uploaded).map((item) => item.key);
  const rejected = required.filter((item) => item.uploaded && item.reviewStatus === 'rejected').map((item) => item.key);
  const pending = required.filter((item) => item.uploaded && item.reviewStatus === 'pending').map((item) => item.key);

  const others = Object.keys(safeDocuments)
    .filter((key) => !requiredKeys.includes(key))
    .map((key) => ({
      key,
      uploaded: isUploaded(safeDocuments[key]),
      reviewStatus: getDocumentReviewStatus(safeDocuments[key]),
      reviewReason: safeDocuments[key]?.reviewReason || '',
    }));

  return {
    required,
    others,
    missing,
    pending,
    rejected,
    allApproved: missing.length === 0 && pending.length === 0 && rejected.length === 0,
  };
};

/// A stored document normalised to an object, so review fields can be set on
/// it. Older registrations stored a bare URL string.
export const toReviewableDocument = (value) => {
  if (typeof value === 'string') {
    return { secureUrl: value, previewUrl: value, uploaded: true };
  }
  return value && typeof value === 'object' ? { ...value } : null;
};

const loadDocumentTemplates = () =>
  DriverNeededDocument.find({
    active: { $ne: false },
    $or: [
      { template_type: 'document' },
      { template_type: { $exists: false } },
      { template_type: null },
      { template_type: '' },
    ],
  })
    .select('name account_type image_type is_required key front_key back_key active template_type')
    .lean();

export const getDriverDocumentReview = async (driverId, admin = null) => {
  assertObjectId(driverId, 'driverId');
  const driver = await Driver.findById(driverId)
    .select('name owner_id service_location_id documents approve status rejectionReason rejectedAt vehicleApproval')
    .lean();
  if (!driver) throw new ApiError(404, 'Driver not found');
  assertServiceLocationScope(admin, driver.service_location_id);

  const templates = await loadDocumentTemplates();
  const requiredKeys = computeRequiredDocumentKeys(templates, documentAccountTypesForDriver(driver));
  const gates = await getOperationsGates();

  return {
    driverId: String(driver._id),
    approve: Boolean(driver.approve),
    status: driver.status || '',
    rejectionReason: driver.rejectionReason || '',
    rejectedAt: driver.rejectedAt || null,
    requireVerifiedDocumentsForApproval: gates.requireVerifiedDocumentsForApproval,
    ...summarizeDocumentReview(driver.documents || {}, requiredKeys),
  };
};

export const reviewDriverDocument = async ({ driverId, documentKey, status, reason = '', admin = null, adminId = null }) => {
  assertObjectId(driverId, 'driverId');
  const key = String(documentKey || '').trim();
  const nextStatus = String(status || '').trim().toLowerCase();
  const trimmedReason = String(reason || '').trim().slice(0, 500);

  if (!key || key.includes('.') || key.startsWith('$')) {
    throw new ApiError(400, 'documentKey is invalid');
  }
  if (!DOCUMENT_REVIEW_STATUSES.includes(nextStatus)) {
    throw new ApiError(400, 'status must be approved or rejected');
  }
  if (nextStatus === 'rejected' && !trimmedReason) {
    throw new ApiError(400, 'A reason is required to reject a document');
  }

  const driver = await Driver.findById(driverId);
  if (!driver) throw new ApiError(404, 'Driver not found');
  assertServiceLocationScope(admin, driver.service_location_id);

  const documents = driver.documents && typeof driver.documents === 'object' ? { ...driver.documents } : {};
  const current = toReviewableDocument(documents[key]);
  if (!current || !isUploaded(current)) {
    throw new ApiError(404, `Document ${key} has not been uploaded`);
  }

  documents[key] = {
    ...current,
    reviewStatus: nextStatus,
    reviewReason: nextStatus === 'rejected' ? trimmedReason : '',
    reviewedBy: adminId ? String(adminId) : null,
    reviewedAt: new Date(),
  };
  driver.documents = documents;
  driver.markModified('documents');
  await driver.save();

  const payload = {
    driverId: String(driver._id),
    documentKey: key,
    reviewStatus: nextStatus,
    reviewReason: documents[key].reviewReason,
    reviewedAt: documents[key].reviewedAt,
  };

  emitToDriverRoom(driver._id, 'driver:document:reviewed', payload);

  if (nextStatus === 'rejected') {
    sendPushNotificationToEntities({
      driverIds: [String(driver._id)],
      title: 'Document rejected',
      body: `Your ${key} was rejected: ${trimmedReason}. Please upload it again.`,
      data: { type: 'driver_document_rejected', documentKey: key, reason: trimmedReason },
    }).catch((error) => console.error('Failed to send document-rejected push', error?.message || error));
  }

  return { ...payload, document: documents[key] };
};

/// Approval guard, called by adminService.updateDriver when approve becomes
/// true. A no-op unless customization.require_verified_documents_for_approval
/// is '1', so approval works exactly as before by default.
export const assertDriverDocumentsReadyForApproval = async (driverId) => {
  const gates = await getOperationsGates();
  if (!gates.requireVerifiedDocumentsForApproval) return;

  const driver = await Driver.findById(driverId).select('owner_id documents').lean();
  if (!driver) throw new ApiError(404, 'Driver not found');

  const templates = await loadDocumentTemplates();
  const requiredKeys = computeRequiredDocumentKeys(templates, documentAccountTypesForDriver(driver));
  const summary = summarizeDocumentReview(driver.documents || {}, requiredKeys);

  if (!summary.allApproved) {
    const parts = [
      summary.missing.length ? `missing: ${summary.missing.join(', ')}` : '',
      summary.pending.length ? `not reviewed: ${summary.pending.join(', ')}` : '',
      summary.rejected.length ? `rejected: ${summary.rejected.join(', ')}` : '',
    ].filter(Boolean);
    throw new ApiError(
      409,
      `Approve every required document before approving the driver (${parts.join('; ')})`,
      { missing: summary.missing, pending: summary.pending, rejected: summary.rejected },
    );
  }
};

/// Turns the whole application down with a reason the driver is shown.
export const rejectDriverApplication = async ({ driverId, reason = '', admin = null }) => {
  assertObjectId(driverId, 'driverId');
  const trimmedReason = String(reason || '').trim().slice(0, 1000);
  if (!trimmedReason) throw new ApiError(400, 'A rejection reason is required');

  const existing = await Driver.findById(driverId).select('service_location_id isOnRide').lean();
  if (!existing) throw new ApiError(404, 'Driver not found');
  assertServiceLocationScope(admin, existing.service_location_id);
  if (existing.isOnRide) throw new ApiError(409, 'Driver is on a trip; reject after it ends');

  const driver = await Driver.findByIdAndUpdate(
    driverId,
    {
      $set: {
        approve: false,
        status: 'rejected',
        isOnline: false,
        rejectionReason: trimmedReason,
        rejectedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).select('_id approve status rejectionReason rejectedAt');

  emitToDriverRoom(driverId, 'driver:application:rejected', {
    driverId: String(driverId),
    reason: trimmedReason,
  });
  sendPushNotificationToEntities({
    driverIds: [String(driverId)],
    title: 'Application not approved',
    body: trimmedReason,
    data: { type: 'driver_application_rejected', reason: trimmedReason },
  }).catch((error) => console.error('Failed to send application-rejected push', error?.message || error));

  return {
    driverId: String(driver._id),
    approve: driver.approve,
    status: driver.status,
    rejectionReason: driver.rejectionReason,
    rejectedAt: driver.rejectedAt,
  };
};
