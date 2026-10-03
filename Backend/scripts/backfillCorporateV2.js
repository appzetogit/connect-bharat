/**
 * Corporate v2 backfill (docs/plans/corporate-v2.md). Idempotent; safe to
 * re-run.
 *
 *   1. Seeds the starting roles (CEO / VP / Employee) for every company that
 *      has no roles yet.
 *   2. Gives every company without a `code` one generated from its name.
 *   3. Assigns the company's default role to employees with no `roleId`.
 *   4. Fills a generated `<CODE>-0001` employee code on employees whose code
 *      is blank.
 *   5. Reports employee codes that are duplicated within a company (they block
 *      the new unique index); it does not change them.
 *
 * Usage:
 *   node scripts/backfillCorporateV2.js            # apply
 *   node scripts/backfillCorporateV2.js --dry-run  # report only, write nothing
 *
 * Afterwards run `node scripts/ensureIndexes.js` to build the new indexes.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Corporate } from '../src/modules/taxi/corporate/models/Corporate.js';
import { CorporateEmployee } from '../src/modules/taxi/corporate/models/CorporateEmployee.js';
import { CorporateRole } from '../src/modules/taxi/corporate/models/CorporateRole.js';
import { ensureCorporateRoles, getDefaultRole } from '../src/modules/taxi/corporate/services/corporateRoleService.js';
import { ensureCorporateCode, generateEmployeeCode } from '../src/modules/taxi/corporate/services/corporateEmployeeCodeService.js';

const dryRun = process.argv.includes('--dry-run');
const log = (...args) => console.log(dryRun ? '[dry-run]' : '[apply]', ...args);

const run = async () => {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName, autoIndex: false });
  const totals = { companies: 0, rolesSeeded: 0, codesGenerated: 0, rolesAssigned: 0, employeeCodes: 0, duplicateCodes: 0 };

  const corporates = await Corporate.find({}).select('_id name code').lean();
  for (const corporate of corporates) {
    totals.companies += 1;
    const label = `${corporate.name} (${corporate._id})`;

    const hasRoles = await CorporateRole.exists({ corporateId: corporate._id });
    if (!hasRoles) {
      totals.rolesSeeded += 1;
      log(label, 'seed roles CEO / VP / Employee');
      if (!dryRun) await ensureCorporateRoles(corporate._id);
    }

    let code = corporate.code;
    if (!code) {
      totals.codesGenerated += 1;
      if (dryRun) log(label, 'generate company code');
      else {
        code = await ensureCorporateCode(corporate._id);
        log(label, `company code ${code}`);
      }
    }

    const unassigned = await CorporateEmployee.countDocuments({ corporateId: corporate._id, roleId: null });
    if (unassigned) {
      totals.rolesAssigned += unassigned;
      if (dryRun) log(label, `assign default role to ${unassigned} employee(s)`);
      else {
        const role = await getDefaultRole(corporate._id);
        if (role) {
          await CorporateEmployee.updateMany({ corporateId: corporate._id, roleId: null }, { $set: { roleId: role._id } });
          log(label, `assigned ${role.name} to ${unassigned} employee(s)`);
        }
      }
    }

    const blank = await CorporateEmployee.find({ corporateId: corporate._id, $or: [{ employeeCode: '' }, { employeeCode: null }, { employeeCode: { $exists: false } }] })
      .sort({ createdAt: 1 })
      .select('_id name')
      .lean();
    for (const employee of blank) {
      totals.employeeCodes += 1;
      if (dryRun) continue;
      const employeeCode = await generateEmployeeCode({ _id: corporate._id, name: corporate.name, code });
      await CorporateEmployee.updateOne(
        { _id: employee._id, $or: [{ employeeCode: '' }, { employeeCode: null }, { employeeCode: { $exists: false } }] },
        { $set: { employeeCode } },
      );
    }
    if (blank.length) log(label, `${dryRun ? 'would fill' : 'filled'} ${blank.length} blank employee code(s)`);

    const duplicates = await CorporateEmployee.aggregate([
      { $match: { corporateId: corporate._id, employeeCode: { $gt: '' } } },
      { $group: { _id: '$employeeCode', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    for (const row of duplicates) {
      totals.duplicateCodes += 1;
      console.warn(`[warn] ${label}: employee code "${row._id}" is used by ${row.count} employees (${row.ids.join(', ')}); fix by hand before building indexes`);
    }
  }

  log('done', totals);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
