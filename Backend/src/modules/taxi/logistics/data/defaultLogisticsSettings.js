/// Defaults for the two settings sections the parcel network reads.
///
/// Kept here rather than in admin/data/defaultBusinessSettings.js so the
/// hub module stays self-contained. They are merged under whatever is stored
/// in AdminBusinessSetting.{delivery,logistics}, the same way
/// transportSettingsService merges transport_ride. Values are strings like
/// the rest of the business settings, because the admin panel edits them as
/// form fields.

/// `delivery`: knobs on the EXISTING single-driver parcel flow
/// (POST /deliveries). Off by default, so turning the hub module on changes
/// nothing about how a direct parcel is priced until the admin opts in.
export const createDefaultDeliverySettings = () => ({
  enable_parcel_surcharges: '0',
  // Weight: billed per kg above the free allowance.
  free_weight_kg: '5',
  per_extra_kg_charge: '0',
  // Fragile: 'flat' or 'percent' (of the trip subtotal).
  fragile_surcharge_type: 'flat',
  fragile_surcharge_value: '0',
  // Express: subtotal × multiplier.
  express_multiplier: '1',
  // Insurance: percent of declared value, clamped to min/max.
  insurance_percent: '0',
  insurance_min: '0',
  insurance_max: '0',
});

/// `logistics`: the hub network itself.
export const createDefaultLogisticsSettings = () => ({
  // 'direct' keeps same-city parcels on POST /deliveries; 'hub' routes them
  // through the hub network too.
  intracity_fulfilment: 'direct',
  intracity_max_km: '60',
  intercity_max_km: '400',
  // How far from the sender/receiver a hub may be to serve them.
  hub_search_radius_km: '50',
  // Pickup slots, in local time ("HH:MM-HH:MM"), and how far ahead the
  // earliest bookable slot must start.
  pickup_slots: ['09:00-12:00', '12:00-15:00', '15:00-18:00', '18:00-21:00'],
  pickup_lead_minutes: '60',
  pickup_booking_days_ahead: '7',
  timezone_offset_minutes: '330',
  // SLA, hours from booking to delivery, per scope. Express halves it.
  sla_hours_intracity: '24',
  sla_hours_intercity: '72',
  sla_hours_long_distance: '120',
  express_sla_factor: '0.5',
  // Delivery attempts before the parcel is automatically returned.
  max_delivery_attempts: '3',
  auto_rto_on_max_attempts: '1',
  rto_on_refusal: '1',
  // Delivery OTP: 4 digits, SMS'd to the receiver when out for delivery.
  require_delivery_otp: '1',
  delivery_otp_max_attempts: '5',
  // Inbound weight re-check: flag when the measured chargeable weight
  // differs from the booked one by more than this percent.
  weight_tolerance_percent: '10',
  // Manifests must be sealed before dispatch.
  require_manifest_seal: '1',
  // Fare paid to a taxi driver for a first/last-mile leg when the vehicle
  // has no delivery tariff in that zone.
  leg_fallback_fare: '80',
  // Default vehicle type for auto-dispatched legs (a Vehicle _id), blank =
  // any vehicle.
  leg_vehicle_type_id: '',
  // Public tracking page base URL printed in the label QR. Blank = the QR
  // holds the bare AWB.
  tracking_base_url: '',
});
