import { Corporate } from '../models/Corporate.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { CorporateCounter } from '../models/CorporateInvoice.js';
import { corporateCodeCandidates, formatEmployeeCode } from './corporateV2Rules.js';

/// Employee IDs (docs/plans/corporate-v2.md §1.2): `<Corporate.code>-0001`
/// from a per-company counter, the same CorporateCounter that numbers
/// invoices (`_id: employee:<corporateId>`).

const isDuplicateKeyError = (error) => error?.code === 11000;

/// The company's code, generating one from its name the first time it is
/// needed. Claimed with a conditional update so two requests cannot give the
/// company two codes, and the unique index on `code` makes it unique.
export const ensureCorporateCode = async (corporateOrId) => {
  const id = corporateOrId?._id || corporateOrId;
  const current = corporateOrId?.code !== undefined && corporateOrId?.name !== undefined
    ? corporateOrId
    : await Corporate.findById(id).select('code name').lean();
  if (!current) return '';
  if (current.code) return current.code;

  for (const candidate of corporateCodeCandidates(current.name)) {
    try {
      const updated = await Corporate.findOneAndUpdate(
        { _id: id, $or: [{ code: '' }, { code: null }, { code: { $exists: false } }] },
        { $set: { code: candidate } },
        { returnDocument: 'after' },
      ).select('code').lean();
      if (updated) return updated.code;
      // Someone else set it meanwhile.
      const fresh = await Corporate.findById(id).select('code').lean();
      if (fresh?.code) return fresh.code;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new Error('Could not generate a unique company code');
};

const nextSeq = async (corporateId) => {
  const counter = await CorporateCounter.findOneAndUpdate(
    { _id: `employee:${corporateId}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return counter.seq;
};

/// The next free generated code. Skips any number a hand-typed code already
/// took, so the counter never hands out a duplicate.
export const generateEmployeeCode = async (corporate) => {
  const code = await ensureCorporateCode(corporate);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = formatEmployeeCode(code, await nextSeq(corporate._id || corporate));
    const taken = await CorporateEmployee.exists({ corporateId: corporate._id || corporate, employeeCode: candidate });
    if (!taken) return candidate;
  }
  throw new Error('Could not generate a unique employee code');
};

/// Saves `employee` (a document) and, when its code is blank, gives it a
/// generated one. Retries on the rare duplicate the unique index catches.
export const saveWithEmployeeCode = async (employee, corporate) => {
  const wantsGenerated = !String(employee.employeeCode || '').trim();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (wantsGenerated) employee.employeeCode = await generateEmployeeCode(corporate);
    try {
      return await employee.save();
    } catch (error) {
      const codeClash = isDuplicateKeyError(error) && JSON.stringify(error.keyPattern || error.keyValue || {}).includes('employeeCode');
      if (codeClash && wantsGenerated) continue;
      throw error;
    }
  }
  throw new Error('Could not save the employee with a unique code');
};
