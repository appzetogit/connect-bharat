/// Defaults for the `rental` business-settings section.
///
/// Kept in the rental module and spread into createDefaultBusinessSettings,
/// so this list can grow without touching the shared defaults file.
///
/// Values are '0'/'1' strings like every other business setting. Everything
/// that changes money or a live flow is off, or matches what rentals did
/// before these settings existed.
export const createDefaultRentalSettings = () => ({
  // Self-drive is what rentals have always been; with-driver is new.
  self_drive_enabled: '1',
  with_driver_enabled: '0',
  // Reject a booking with 409 when no unit of the vehicle type is free for the
  // window. Off so setups that never entered units keep taking bookings.
  enforce_inventory: '0',
  // Approve a rider's extension request without an admin when a car is free.
  auto_approve_extensions: '0',
  // Bill km beyond the package allowance from the inspection odometer
  // readings. Captured per booking at creation time.
  bill_extra_km: '0',
  // Reject a self-drive booking that has no driving-licence image. The apps
  // collect it today; this makes the server insist.
  require_self_drive_kyc: '0',
  // Email the rental invoice PDF to the rider when the rental completes.
  email_invoice_on_completion: '1',
});
