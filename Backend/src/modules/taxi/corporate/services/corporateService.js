import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { WebsiteEnquiry } from '../../admin/models/WebsiteEnquiry.js';
import { sendEmail } from '../../services/mailService.js';
import { CORPORATE_SERVICES, Corporate } from '../models/Corporate.js';
import { CORPORATE_ADMIN_ROLES, CorporateAdmin } from '../models/CorporateAdmin.js';
import { CorporateDepartment } from '../models/CorporateDepartment.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { CorporateTripPolicy } from '../models/CorporateTripPolicy.js';
import { CorporateTripRequest } from '../models/CorporateTripRequest.js';
import { CorporateInvoice } from '../models/CorporateInvoice.js';
import { adjustCorporateAccount } from './corporateLedger.js';
import { assertPasswordStrength, hashCorporatePassword, serializeCorporateAdmin } from './corporateAuthService.js';
import { normalizeIndianPhone, round2 } from './corporatePolicyEngine.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';
import { BILLING_CYCLES, EXCESS_PAYMENT_METHODS, TRAVEL_ZONE_MODES, TRAVEL_ZONE_RULES } from '../models/Corporate.js';
import { ensureCorporateRoles } from './corporateRoleService.js';

/// Company lifecycle (SOW 8.1, 2.13), departments, policies and panel users.

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (value) => String(value ?? '').trim();
const isId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const cleanServices = (list) =>
  Array.isArray(list) ? [...new Set(list.map((item) => str(item).toLowerCase()).filter((item) => CORPORATE_SERVICES.includes(item)))] : undefined;

const cleanIds = (list) => (Array.isArray(list) ? list.filter(isId).map((id) => new mongoose.Types.ObjectId(String(id))) : undefined);

const generateCorporateCode = (name) => {
  const letters = str(name).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(3, 'X');
  return `${letters}${crypto.randomInt(1000, 10000)}`;
};

/// Fields a company or an admin may set on the profile. Money and status
/// fields are handled separately (admin only).
const pickProfile = (body = {}) => {
  const profile = {};
  if (body.name !== undefined) profile.name = str(body.name);
  if (body.legalName !== undefined) profile.legalName = str(body.legalName);
  if (body.industry !== undefined) profile.industry = str(body.industry);
  if (body.employeeCountEstimate !== undefined) profile.employeeCountEstimate = Math.max(0, Number(body.employeeCountEstimate) || 0);
  if (body.billingEmail !== undefined) profile.billingEmail = str(body.billingEmail).toLowerCase();
  if (body.gstin !== undefined) {
    const gstin = str(body.gstin).toUpperCase();
    if (gstin && !GSTIN_PATTERN.test(gstin)) throw new ApiError(400, 'GSTIN is not valid');
    profile.gstin = gstin;
  }
  if (body.pan !== undefined) {
    const pan = str(body.pan).toUpperCase();
    if (pan && !PAN_PATTERN.test(pan)) throw new ApiError(400, 'PAN is not valid');
    profile.pan = pan;
  }
  if (body.billingAddress && typeof body.billingAddress === 'object') {
    profile.billingAddress = {
      line1: str(body.billingAddress.line1),
      line2: str(body.billingAddress.line2),
      city: str(body.billingAddress.city),
      state: str(body.billingAddress.state),
      pincode: str(body.billingAddress.pincode),
      country: str(body.billingAddress.country) || 'India',
    };
  }
  if (body.contact && typeof body.contact === 'object') {
    profile.contact = {
      name: str(body.contact.name),
      email: str(body.contact.email).toLowerCase(),
      phone: normalizeIndianPhone(body.contact.phone),
      designation: str(body.contact.designation),
    };
  }
  return profile;
};

/// Commercial terms, admin only.
const pickTerms = (body = {}) => {
  const terms = {};
  if (body.creditLimit !== undefined) terms.creditLimit = Math.max(0, Number(body.creditLimit) || 0);
  if (body.creditGracePercent !== undefined) {
    terms.creditGracePercent = body.creditGracePercent === null || body.creditGracePercent === '' ? null : Math.max(0, Number(body.creditGracePercent) || 0);
  }
  if (body.paymentTermsDays !== undefined) terms.paymentTermsDays = Math.max(0, Math.round(Number(body.paymentTermsDays) || 0));
  if (body.approvalExpiryMinutes !== undefined) {
    terms.approvalExpiryMinutes = body.approvalExpiryMinutes === null || body.approvalExpiryMinutes === '' ? null : Math.max(1, Math.round(Number(body.approvalExpiryMinutes) || 1));
  }
  if (body.discount && typeof body.discount === 'object') {
    const type = body.discount.type === 'flat' ? 'flat' : 'percentage';
    const value = Math.max(0, Number(body.discount.value) || 0);
    if (type === 'percentage' && value > 100) throw new ApiError(400, 'A percentage discount cannot exceed 100');
    terms.discount = {
      type,
      value,
      maxPerTrip: Math.max(0, Number(body.discount.maxPerTrip) || 0),
      appliesTo: cleanServices(body.discount.appliesTo) || [...CORPORATE_SERVICES],
    };
  }
  const allowedServices = cleanServices(body.allowedServices);
  if (allowedServices) terms.allowedServices = allowedServices;
  const vehicleIds = cleanIds(body.allowedVehicleTypeIds);
  if (vehicleIds) terms.allowedVehicleTypeIds = vehicleIds;
  const locationIds = cleanIds(body.serviceLocationIds);
  if (locationIds) terms.serviceLocationIds = locationIds;
  if (body.notes !== undefined) terms.notes = str(body.notes);
  Object.assign(terms, pickV2Terms(body));
  return terms;
};

const money = (value, field) => {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric < 0) throw new ApiError(400, `${field} must be zero or more`);
  return round2(numeric);
};

const pickRate = (row = {}, field = 'tariff') => ({
  baseFare: money(row.baseFare, `${field}.baseFare`),
  baseKm: money(row.baseKm, `${field}.baseKm`),
  perKm: money(row.perKm, `${field}.perKm`),
  perMinute: money(row.perMinute, `${field}.perMinute`),
  minimumFare: money(row.minimumFare, `${field}.minimumFare`),
});

/// Office boundary as stored. Offices take { name, address, lat, lng,
/// radiusKm } or { location: { coordinates: [lng, lat] } }.
export const pickTravelZone = (zone = {}) => {
  const mode = zone.mode === undefined ? 'free_roaming' : zone.mode;
  if (!TRAVEL_ZONE_MODES.includes(mode)) throw new ApiError(400, `travelZone.mode must be one of ${TRAVEL_ZONE_MODES.join(', ')}`);
  const rule = zone.rule === undefined ? 'both_ends' : zone.rule;
  if (!TRAVEL_ZONE_RULES.includes(rule)) throw new ApiError(400, `travelZone.rule must be one of ${TRAVEL_ZONE_RULES.join(', ')}`);
  const offices = (Array.isArray(zone.offices) ? zone.offices : []).map((office, index) => {
    const coords = Array.isArray(office?.location?.coordinates) ? office.location.coordinates : [office?.lng, office?.lat];
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new ApiError(400, `travelZone.offices[${index}] needs a valid lat/lng`);
    }
    const radiusKm = Number(office?.radiusKm);
    if (!(radiusKm > 0)) throw new ApiError(400, `travelZone.offices[${index}].radiusKm must be greater than 0`);
    return {
      ...(isId(office?._id || office?.id) ? { _id: office._id || office.id } : {}),
      name: str(office?.name),
      address: str(office?.address),
      location: { type: 'Point', coordinates: [lng, lat] },
      radiusKm: round2(radiusKm),
    };
  });
  if (mode === 'office_boundary' && !offices.length) throw new ApiError(400, 'Add at least one office to use an office boundary');
  return { mode, rule, offices };
};

/// Corporate v2 terms (contract §1.3), admin only.
const pickV2Terms = (body = {}) => {
  const terms = {};
  if (body.billingCycle !== undefined) {
    if (!BILLING_CYCLES.includes(body.billingCycle)) throw new ApiError(400, 'billingCycle must be weekly or monthly');
    terms.billingCycle = body.billingCycle;
  }
  if (body.tariff && typeof body.tariff === 'object') {
    const tariff = body.tariff;
    const vehicleRows = Array.isArray(tariff.byVehicleType) ? tariff.byVehicleType : [];
    const seen = new Set();
    terms.tariff = {
      enabled: tariff.enabled === true || tariff.enabled === 'true',
      ...pickRate(tariff),
      byVehicleType: vehicleRows.map((row, index) => {
        if (!isId(row?.vehicleTypeId)) throw new ApiError(400, `tariff.byVehicleType[${index}].vehicleTypeId is invalid`);
        if (seen.has(String(row.vehicleTypeId))) throw new ApiError(400, 'tariff.byVehicleType lists a vehicle type twice');
        seen.add(String(row.vehicleTypeId));
        return { vehicleTypeId: row.vehicleTypeId, ...pickRate(row, `tariff.byVehicleType[${index}]`) };
      }),
      appliesTo: cleanServices(tariff.appliesTo)?.length ? cleanServices(tariff.appliesTo) : ['ride', 'intercity'],
    };
  }
  if (body.driverCommission && typeof body.driverCommission === 'object') {
    const type = body.driverCommission.type === 'fixed' ? 'fixed' : 'percentage';
    const value = money(body.driverCommission.value, 'driverCommission.value');
    if (type === 'percentage' && value > 100) throw new ApiError(400, 'A percentage commission cannot exceed 100');
    terms.driverCommission = { enabled: body.driverCommission.enabled === true || body.driverCommission.enabled === 'true', type, value };
  }
  if (body.travelZone && typeof body.travelZone === 'object') terms.travelZone = pickTravelZone(body.travelZone);
  if (body.excessPayment && typeof body.excessPayment === 'object') {
    const methods = Array.isArray(body.excessPayment.allowedMethods)
      ? [...new Set(body.excessPayment.allowedMethods.map((item) => str(item).toLowerCase()).filter((item) => EXCESS_PAYMENT_METHODS.includes(item)))]
      : [];
    if (!methods.length) throw new ApiError(400, `excessPayment.allowedMethods needs at least one of ${EXCESS_PAYMENT_METHODS.join(', ')}`);
    terms.excessPayment = { allowedMethods: methods };
  }
  return terms;
};

/// Panel GET / PUT /travel-zone.
export const getCorporateTravelZone = (corporate) => {
  const zone = corporate.travelZone?.toObject ? corporate.travelZone.toObject() : (corporate.travelZone || {});
  return { mode: zone.mode || 'free_roaming', rule: zone.rule || 'both_ends', offices: zone.offices || [] };
};

export const updateCorporateTravelZone = async ({ corporateId, body = {} }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  corporate.travelZone = pickTravelZone(body);
  await corporate.save();
  return getCorporateTravelZone(corporate);
};

const createOwnerAdmin = async ({ corporateId, owner = {}, requirePassword }) => {
  const email = str(owner.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'A valid owner email is required');
  if (!str(owner.name)) throw new ApiError(400, 'Owner name is required');
  if (await CorporateAdmin.exists({ email })) throw new ApiError(409, 'This email is already registered for a corporate panel');
  if (requirePassword || owner.password) assertPasswordStrength(owner.password);

  return CorporateAdmin.create({
    corporateId,
    name: str(owner.name),
    email,
    phone: normalizeIndianPhone(owner.phone),
    passwordHash: owner.password ? await hashCorporatePassword(owner.password) : '',
    role: 'owner',
  });
};

/// Public self-registration. The company starts `pending` and cannot bill
/// until an admin approves it and sets a credit limit.
export const registerCorporate = async (body = {}) => {
  const settings = await getCorporateSettings();
  if (!isFlagOn(settings.registration_enabled)) throw new ApiError(403, 'Corporate registration is closed');

  const profile = pickProfile(body);
  if (!profile.name) throw new ApiError(400, 'Company name is required');
  const owner = body.owner || body.admin || {};

  // Validate the owner before creating anything, so a duplicate email does not
  // leave an orphan company behind.
  const ownerEmail = str(owner.email).toLowerCase();
  if (!EMAIL_PATTERN.test(ownerEmail)) throw new ApiError(400, 'A valid owner email is required');
  if (await CorporateAdmin.exists({ email: ownerEmail })) throw new ApiError(409, 'This email is already registered for a corporate panel');
  assertPasswordStrength(owner.password);

  const corporate = await Corporate.create({ ...profile, code: generateCorporateCode(profile.name), status: 'pending', source: 'self' });
  try {
    const admin = await createOwnerAdmin({ corporateId: corporate._id, owner, requirePassword: true });
    await ensureCorporateRoles(corporate._id).catch((error) => console.warn('[corporate] role seeding failed', error.message));
    return { corporate: corporate.toObject(), admin: serializeCorporateAdmin(admin) };
  } catch (error) {
    await Corporate.deleteOne({ _id: corporate._id });
    throw error;
  }
};

/// Admin-created company (2.13). Approved straight away unless `status` says
/// otherwise. The owner can sign in with phone OTP and set a password, or the
/// admin can set one here.
export const createCorporateByAdmin = async ({ adminId, body = {}, enquiryId = null }) => {
  const profile = pickProfile(body);
  if (!profile.name) throw new ApiError(400, 'Company name is required');
  const terms = pickTerms(body);
  const status = body.status === 'pending' ? 'pending' : 'approved';
  const owner = body.owner || {};
  const ownerEmail = str(owner.email).toLowerCase();
  if (!EMAIL_PATTERN.test(ownerEmail)) throw new ApiError(400, 'A valid owner email is required');
  if (await CorporateAdmin.exists({ email: ownerEmail })) throw new ApiError(409, 'This email is already registered for a corporate panel');
  if (owner.password) assertPasswordStrength(owner.password);

  const corporate = await Corporate.create({
    ...profile,
    ...terms,
    code: generateCorporateCode(profile.name),
    status,
    source: enquiryId ? 'enquiry' : 'admin',
    enquiryId,
    createdByAdminId: adminId || null,
    approvedBy: status === 'approved' ? adminId || null : null,
    approvedAt: status === 'approved' ? new Date() : null,
  });
  try {
    const admin = await createOwnerAdmin({ corporateId: corporate._id, owner, requirePassword: false });
    await ensureCorporateRoles(corporate._id).catch((error) => console.warn('[corporate] role seeding failed', error.message));
    return { corporate: corporate.toObject(), admin: serializeCorporateAdmin(admin) };
  } catch (error) {
    await Corporate.deleteOne({ _id: corporate._id });
    throw error;
  }
};

/// Turns a website "corporate" lead into a company. The enquiry's own fields
/// pre-fill the profile; anything in the request body wins.
export const createCorporateFromEnquiry = async ({ adminId, enquiryId, body = {} }) => {
  if (!isId(enquiryId)) throw new ApiError(400, 'Invalid enquiry id');
  const enquiry = await WebsiteEnquiry.findById(enquiryId).lean();
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  if (enquiry.type !== 'corporate') throw new ApiError(400, 'Only corporate enquiries can be converted');
  const already = await Corporate.findOne({ enquiryId }).select('_id name').lean();
  if (already) throw new ApiError(409, `This enquiry was already converted to ${already.name}`);

  const details = enquiry.details || {};
  const merged = {
    name: details.companyName || details.company || details.company_name || enquiry.name,
    contact: { name: enquiry.name, email: enquiry.email, phone: enquiry.phone, designation: details.designation || '' },
    employeeCountEstimate: Number(details.employees || details.employeeCount || details.teamSize) || 0,
    ...body,
    owner: { name: enquiry.name, email: enquiry.email, phone: enquiry.phone, ...(body.owner || {}) },
  };

  const result = await createCorporateByAdmin({ adminId, body: merged, enquiryId });
  await WebsiteEnquiry.updateOne(
    { _id: enquiryId },
    { $set: { status: 'closed', notes: `${enquiry.notes ? `${enquiry.notes}\n` : ''}Converted to corporate ${result.corporate.code}` } },
  );
  return result;
};

const getCorporateOrThrow = async (corporateId) => {
  if (!isId(corporateId)) throw new ApiError(400, 'Invalid corporate id');
  const corporate = await Corporate.findById(corporateId);
  if (!corporate) throw new ApiError(404, 'Corporate not found');
  return corporate;
};

const notifyOwner = async (corporate, subject, text) => {
  const owner = await CorporateAdmin.findOne({ corporateId: corporate._id, role: 'owner' }).lean();
  const to = owner?.email || corporate.contact?.email;
  if (!to) return;
  await sendEmail({ to, subject, text }).catch((error) => console.warn('[corporate] owner email failed', error.message));
};

export const approveCorporate = async ({ adminId, corporateId, body = {} }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  if (corporate.status === 'approved') throw new ApiError(409, 'Corporate is already approved');
  corporate.set({ ...pickTerms(body), status: 'approved', approvedBy: adminId || null, approvedAt: new Date(), rejectionReason: '', suspendedReason: '' });
  await corporate.save();
  notifyOwner(corporate, 'Your corporate account is approved', `${corporate.name} is approved. Credit limit: Rs ${corporate.creditLimit}. You can now add employees in the corporate panel.`);
  return corporate.toObject();
};

export const rejectCorporate = async ({ corporateId, reason = '' }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  if (!str(reason)) throw new ApiError(400, 'A rejection reason is required');
  corporate.status = 'rejected';
  corporate.rejectionReason = str(reason);
  await corporate.save();
  notifyOwner(corporate, 'Your corporate registration was not approved', `Reason: ${corporate.rejectionReason}`);
  return corporate.toObject();
};

/// Suspending stops new bookings at once (validateCorporateBooking checks
/// status); trips already running finish and are billed as usual.
export const suspendCorporate = async ({ corporateId, reason = '', suspend = true }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  if (suspend) {
    corporate.status = 'suspended';
    corporate.suspendedReason = str(reason);
  } else {
    if (corporate.status !== 'suspended') throw new ApiError(409, 'Corporate is not suspended');
    corporate.status = 'approved';
    corporate.suspendedReason = '';
  }
  await corporate.save();
  return corporate.toObject();
};

export const updateCorporateByAdmin = async ({ corporateId, body = {} }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  corporate.set({ ...pickProfile(body), ...pickTerms(body) });
  await corporate.save();
  return corporate.toObject();
};

/// Company-side profile edit: contact details only, never terms or status.
export const updateCorporateProfile = async ({ corporateId, body = {} }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  const profile = pickProfile(body);
  delete profile.name;
  delete profile.gstin;
  delete profile.pan;
  corporate.set(profile);
  await corporate.save();
  return corporate.toObject();
};

export const adjustCorporateOutstandingByAdmin = async ({ adminId, corporateId, amount, note = '' }) => {
  await getCorporateOrThrow(corporateId);
  const value = round2(amount);
  if (!value) throw new ApiError(400, 'amount must be non-zero');
  return adjustCorporateAccount({
    corporateId,
    amount: value,
    reference: { type: 'admin_adjustment', id: `${adminId || 'admin'}:${Date.now()}` },
    description: str(note) || 'Admin adjustment',
    metadata: { adminId: adminId ? String(adminId) : null },
  });
};

export const listCorporates = async ({ status = '', search = '', page = 1, limit = 25 }) => {
  const filter = {};
  if (status) filter.status = status;
  const term = str(search);
  if (term) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: pattern }, { legalName: pattern }, { code: pattern }, { gstin: pattern }, { 'contact.email': pattern }];
  }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const [items, total, counts] = await Promise.all([
    Corporate.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    Corporate.countDocuments(filter),
    Corporate.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const employeeCounts = await CorporateEmployee.aggregate([
    { $match: { corporateId: { $in: items.map((item) => item._id) }, active: true } },
    { $group: { _id: '$corporateId', count: { $sum: 1 } } },
  ]);
  const employeesById = new Map(employeeCounts.map((row) => [String(row._id), row.count]));
  return {
    items: items.map((item) => ({ ...item, activeEmployees: employeesById.get(String(item._id)) || 0 })),
    total,
    page: safePage,
    limit: safeLimit,
    statusCounts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
  };
};

export const getCorporateDetail = async ({ corporateId }) => {
  const corporate = await getCorporateOrThrow(corporateId);
  const [admins, departments, employeeCount, pendingApprovals, openInvoices, policies] = await Promise.all([
    CorporateAdmin.find({ corporateId }).lean(),
    CorporateDepartment.find({ corporateId }).lean(),
    CorporateEmployee.countDocuments({ corporateId, active: true }),
    CorporateTripRequest.countDocuments({ corporateId, status: 'pending' }),
    CorporateInvoice.find({ corporateId, status: { $in: ['issued', 'partially_paid', 'overdue'] } }).select('invoiceNumber total balanceDue dueDate status').lean(),
    CorporateTripPolicy.find({ corporateId }).lean(),
  ]);
  return {
    corporate: corporate.toObject(),
    admins: admins.map(serializeCorporateAdmin),
    departments,
    policies,
    employeeCount,
    pendingApprovals,
    openInvoices,
    invoicedDue: round2(openInvoices.reduce((sum, invoice) => sum + (invoice.balanceDue || 0), 0)),
  };
};

// --- departments -----------------------------------------------------------

const pickDepartment = async (corporateId, body = {}) => {
  const fields = {};
  if (body.name !== undefined) fields.name = str(body.name);
  if (body.code !== undefined) fields.code = str(body.code).toUpperCase();
  if (body.costCenter !== undefined) fields.costCenter = str(body.costCenter);
  if (body.monthlyBudget !== undefined) fields.monthlyBudget = Math.max(0, Number(body.monthlyBudget) || 0);
  if (body.active !== undefined) fields.active = body.active !== false && body.active !== 'false';
  if (body.approverIds !== undefined) {
    const ids = cleanIds(body.approverIds) || [];
    const valid = await CorporateAdmin.find({ _id: { $in: ids }, corporateId }).select('_id').lean();
    fields.approverIds = valid.map((item) => item._id);
  }
  return fields;
};

export const listDepartments = async ({ corporateId }) => {
  const [departments, counts] = await Promise.all([
    CorporateDepartment.find({ corporateId }).sort({ name: 1 }).populate('approverIds', 'name email role').lean(),
    CorporateEmployee.aggregate([
      { $match: { corporateId: new mongoose.Types.ObjectId(String(corporateId)), active: true } },
      { $group: { _id: '$departmentId', count: { $sum: 1 } } },
    ]),
  ]);
  const countById = new Map(counts.map((row) => [String(row._id), row.count]));
  return departments.map((department) => ({ ...department, activeEmployees: countById.get(String(department._id)) || 0 }));
};

export const createDepartment = async ({ corporateId, body = {} }) => {
  const fields = await pickDepartment(corporateId, body);
  if (!fields.name) throw new ApiError(400, 'Department name is required');
  try {
    return (await CorporateDepartment.create({ ...fields, corporateId })).toObject();
  } catch (error) {
    if (error?.code === 11000) throw new ApiError(409, 'A department with this name already exists');
    throw error;
  }
};

export const updateDepartment = async ({ corporateId, departmentId, body = {} }) => {
  if (!isId(departmentId)) throw new ApiError(400, 'Invalid department id');
  const department = await CorporateDepartment.findOne({ _id: departmentId, corporateId });
  if (!department) throw new ApiError(404, 'Department not found');
  department.set(await pickDepartment(corporateId, body));
  try {
    await department.save();
  } catch (error) {
    if (error?.code === 11000) throw new ApiError(409, 'A department with this name already exists');
    throw error;
  }
  return department.toObject();
};

/// Departments with employees are deactivated rather than deleted, so past
/// trips and invoices keep their department name.
export const deleteDepartment = async ({ corporateId, departmentId }) => {
  if (!isId(departmentId)) throw new ApiError(400, 'Invalid department id');
  const inUse = await CorporateEmployee.exists({ corporateId, departmentId });
  if (inUse) {
    await CorporateDepartment.updateOne({ _id: departmentId, corporateId }, { $set: { active: false } });
    return { deleted: false, deactivated: true };
  }
  await CorporateDepartment.deleteOne({ _id: departmentId, corporateId });
  await CorporateTripPolicy.deleteOne({ corporateId, departmentId });
  return { deleted: true };
};

// --- policies --------------------------------------------------------------

const HHMM = /^\d{1,2}:\d{2}$/;

const pickPolicy = (body = {}) => {
  const fields = {};
  if (body.name !== undefined) fields.name = str(body.name);
  if (body.active !== undefined) fields.active = body.active !== false && body.active !== 'false';
  const services = cleanServices(body.allowedServices);
  if (services) fields.allowedServices = services;
  const vehicles = cleanIds(body.allowedVehicleTypeIds);
  if (vehicles) fields.allowedVehicleTypeIds = vehicles;
  if (Array.isArray(body.allowedHours)) {
    fields.allowedHours = body.allowedHours.map((window) => {
      if (!HHMM.test(str(window?.start)) || !HHMM.test(str(window?.end))) throw new ApiError(400, 'allowedHours start/end must be HH:mm');
      return {
        days: Array.isArray(window.days) ? window.days.map(Number).filter((day) => day >= 0 && day <= 6) : [],
        start: str(window.start),
        end: str(window.end),
      };
    });
  }
  for (const key of ['outsideHoursAction', 'overMaxFareAction']) {
    if (body[key] !== undefined) fields[key] = ['block', 'approval'].includes(body[key]) ? body[key] : null;
  }
  for (const key of ['maxFarePerTrip', 'requireApprovalAbove']) {
    if (body[key] !== undefined) fields[key] = body[key] === null || body[key] === '' ? null : Math.max(0, Number(body[key]) || 0);
  }
  if (body.requireApprovalAlways !== undefined) {
    fields.requireApprovalAlways = body.requireApprovalAlways === null ? null : body.requireApprovalAlways === true || body.requireApprovalAlways === 'true';
  }
  return fields;
};

export const listPolicies = async ({ corporateId }) =>
  CorporateTripPolicy.find({ corporateId }).populate('departmentId', 'name code').sort({ departmentId: 1 }).lean();

/// One policy per company (departmentId null) and per department, so this is
/// an upsert keyed on the department.
export const upsertPolicy = async ({ corporateId, departmentId = null, body = {} }) => {
  if (departmentId) {
    if (!isId(departmentId)) throw new ApiError(400, 'Invalid department id');
    const department = await CorporateDepartment.exists({ _id: departmentId, corporateId });
    if (!department) throw new ApiError(404, 'Department not found');
  }
  const fields = pickPolicy(body);
  return CorporateTripPolicy.findOneAndUpdate(
    { corporateId, departmentId: departmentId || null },
    { ...(Object.keys(fields).length ? { $set: fields } : {}), $setOnInsert: { corporateId, departmentId: departmentId || null } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
};

export const deletePolicy = async ({ corporateId, policyId }) => {
  if (!isId(policyId)) throw new ApiError(400, 'Invalid policy id');
  await CorporateTripPolicy.deleteOne({ _id: policyId, corporateId });
  return { deleted: true };
};

// --- panel users -----------------------------------------------------------

export const listCorporateAdmins = async ({ corporateId }) =>
  (await CorporateAdmin.find({ corporateId }).sort({ createdAt: 1 }).lean()).map(serializeCorporateAdmin);

export const createCorporateAdminUser = async ({ corporateId, body = {}, actorRole }) => {
  const role = CORPORATE_ADMIN_ROLES.includes(body.role) ? body.role : 'approver';
  if (role === 'owner' && actorRole !== 'owner') throw new ApiError(403, 'Only an owner can add another owner');
  const email = str(body.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'A valid email is required');
  if (!str(body.name)) throw new ApiError(400, 'name is required');
  if (await CorporateAdmin.exists({ email })) throw new ApiError(409, 'This email is already in use');
  if (body.password) assertPasswordStrength(body.password);
  const departmentIds = cleanIds(body.departmentIds) || [];
  const admin = await CorporateAdmin.create({
    corporateId,
    name: str(body.name),
    email,
    phone: normalizeIndianPhone(body.phone),
    role,
    departmentIds,
    passwordHash: body.password ? await hashCorporatePassword(body.password) : '',
  });
  return serializeCorporateAdmin(admin);
};

export const updateCorporateAdminUser = async ({ corporateId, adminUserId, body = {}, actor }) => {
  if (!isId(adminUserId)) throw new ApiError(400, 'Invalid user id');
  const admin = await CorporateAdmin.findOne({ _id: adminUserId, corporateId });
  if (!admin) throw new ApiError(404, 'User not found');
  if (admin.role === 'owner' && actor.role !== 'owner') throw new ApiError(403, 'Only an owner can change an owner');
  if (String(admin._id) === String(actor._id) && body.active === false) throw new ApiError(400, 'You cannot deactivate yourself');
  if (body.name !== undefined) admin.name = str(body.name);
  if (body.phone !== undefined) admin.phone = normalizeIndianPhone(body.phone);
  if (body.role !== undefined && CORPORATE_ADMIN_ROLES.includes(body.role)) {
    if (body.role === 'owner' && actor.role !== 'owner') throw new ApiError(403, 'Only an owner can grant owner');
    admin.role = body.role;
  }
  if (body.departmentIds !== undefined) admin.departmentIds = cleanIds(body.departmentIds) || [];
  if (body.active !== undefined) admin.active = body.active !== false && body.active !== 'false';
  if (body.password) {
    assertPasswordStrength(body.password);
    admin.passwordHash = await hashCorporatePassword(body.password);
  }
  await admin.save();
  return serializeCorporateAdmin(admin);
};
