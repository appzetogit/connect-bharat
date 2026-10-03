/// Defaults for the `corporate` section of AdminBusinessSetting.
///
/// Kept in the corporate module rather than admin/data/defaultBusinessSettings.js
/// so this feature does not touch that shared file; the merge with the stored
/// section happens in corporateSettingsService.js the same way
/// transportSettingsService does it. Values are strings for the '1'/'0' flags
/// to match the rest of the business settings.
///
/// Anything that moves money on its own (auto-generating or auto-issuing
/// invoices, blocking on overdue) is off by default. Corporate booking itself
/// is on, because it only works for a company an admin has approved and given
/// a credit limit, which is already an explicit opt-in.
export const createDefaultCorporateSettings = () => ({
  /// Master switch for `paymentMethod: 'corporate'` and the rider endpoint.
  booking_enabled: '1',
  /// Public self-registration at POST /corporate/register.
  registration_enabled: '1',
  /// Minutes a trip waits for an approver before it is cancelled. Each company
  /// can override this (`Corporate.approvalExpiryMinutes`).
  default_approval_expiry_minutes: 30,
  /// How far over its credit limit a company may run, as a percent of the
  /// limit, plus a flat amount. Per-company `creditGracePercent` overrides the
  /// percent.
  credit_grace_percent: 0,
  credit_grace_amount: 0,
  /// Refuse new corporate bookings while any invoice is overdue.
  block_booking_when_overdue: '0',
  /// Monthly job: on the 1st (IST), draft last month's invoice for every
  /// approved company.
  auto_generate_invoices: '0',
  /// Monthly job: issue and email those drafts straight away.
  auto_issue_invoices: '0',
  invoice_prefix: 'CORP',
  /// GST on passenger transport. Fares are treated as tax-inclusive unless
  /// `invoice_fare_includes_tax` is '0'.
  invoice_gst_percent: 5,
  invoice_fare_includes_tax: '1',
  /// Printed on invoices; its first two digits decide CGST+SGST vs IGST.
  supplier_gstin: '',
  supplier_legal_name: '',
  supplier_address: '',
  invoice_footer_note: 'This is a computer generated invoice.',
  /// Employee invite and approver alerts by SMS go through SMS India Hub,
  /// which only delivers DLT-registered templates. Off until a template id is
  /// configured; push and email are used regardless.
  invite_sms_enabled: '0',
  invite_sms_template_id: '',
  /// Placeholders: {name} {company} {app}
  invite_sms_text: 'Hi {name}, {company} has added you to {app} corporate travel. Log in with this number to book trips billed to your company.',
  approver_sms_enabled: '0',
  approver_sms_template_id: '',
  approver_sms_text: '{employee} has requested a {service} trip of Rs {amount}. Approve it in the {app} corporate panel.',
  approver_email_enabled: '1',
  // --- Corporate v2 master switches (docs/plans/corporate-v2.md §4). Each
  // only gates a per-company setting that itself defaults off, so these
  // being on changes nothing until a company is configured.
  /// Role km allowances (and so the employee-paid excess split).
  allowance_enabled: '1',
  /// Company tariffs (Corporate.tariff).
  tariff_enabled: '1',
  /// Office boundaries (Corporate.travelZone).
  travel_zone_enabled: '1',
  /// Panel bookings for employees (POST /corporate/bookings).
  travel_desk_enabled: '1',
});
