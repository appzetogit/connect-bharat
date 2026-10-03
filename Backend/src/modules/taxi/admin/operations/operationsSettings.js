import { getOrLoadCachedValue } from '../../../../utils/cache.js';
import { createDefaultBusinessSettings } from '../data/defaultBusinessSettings.js';
import { AdminBusinessSetting } from '../models/AdminBusinessSetting.js';

const SETTINGS_CACHE_TTL_MS = 30_000;

/// Fallbacks for the two gates this module owns. They are also in
/// defaultBusinessSettings.customization; repeating them here means a merge
/// that loses those two lines still leaves both gates off rather than undefined.
const OPERATIONS_GATE_DEFAULTS = Object.freeze({
  require_verified_documents_for_approval: '0',
  require_vehicle_approval: '0',
});

/// The admin panel stores toggles as '1'/'0' strings, but older documents and
/// API callers also send booleans and numbers. Anything else is off.
export const isSettingEnabled = (value) => {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const loadCustomization = async () => {
  const defaults = createDefaultBusinessSettings().customization || {};
  const stored = await AdminBusinessSetting.findOne({ scope: 'default' })
    .select('customization')
    .lean();

  return {
    ...OPERATIONS_GATE_DEFAULTS,
    ...defaults,
    ...(stored?.customization || {}),
  };
};

/// Cached for 30s like the other settings readers, because the vehicle gate is
/// read on every dispatch attempt.
export const getOperationsGates = async () => {
  const customization = await getOrLoadCachedValue('cache:settings:admin_operations_gates', {
    ttlMs: SETTINGS_CACHE_TTL_MS,
    load: loadCustomization,
  });

  return {
    requireVerifiedDocumentsForApproval: isSettingEnabled(
      customization?.require_verified_documents_for_approval,
    ),
    requireVehicleApproval: isSettingEnabled(customization?.require_vehicle_approval),
  };
};
