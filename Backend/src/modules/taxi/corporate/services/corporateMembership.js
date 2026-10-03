import mongoose from 'mongoose';
import { Corporate } from '../models/Corporate.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';

/// The membership a rider books under. A rider can belong to more than one
/// company; without an explicit `corporateId` the oldest active one is used
/// (preferring an approved company).
export const findActiveMembership = async ({ userId, corporateId = null }) => {
  const filter = { userId, active: true };
  if (corporateId && mongoose.Types.ObjectId.isValid(String(corporateId))) filter.corporateId = corporateId;
  const employees = await CorporateEmployee.find(filter).sort({ createdAt: 1 }).lean();
  if (!employees.length) return null;

  const corporates = await Corporate.find({ _id: { $in: employees.map((item) => item.corporateId) } }).lean();
  const byId = new Map(corporates.map((item) => [String(item._id), item]));
  const employee = employees.find((item) => byId.get(String(item.corporateId))?.status === 'approved') || employees[0];
  return { employee, corporate: byId.get(String(employee.corporateId)) || null };
};
