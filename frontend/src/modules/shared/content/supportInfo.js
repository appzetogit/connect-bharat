import useLandingContent from '../../landing/useLandingContent';

/**
 * Support/company details shown on the legal pages and the rider, driver and
 * owner support screens.
 *
 * These used to be a hardcoded block describing a different product entirely —
 * another company's name, owner, Noida address, phone number and an email
 * containing a space — which shipped publicly on /terms and /privacy and inside
 * both apps. They now come from the CMS contact section, so the admin panel is
 * the one place they are set.
 *
 * The owner is the first founder on the About page (CMS about.founders), so
 * renaming them there updates the support and legal pages too.
 */

const STATIC_DETAILS = {
  companyName: 'Connect Bharat',
  supportLabel: '24x7 customer support',
  responseTime: 'Replies typically within 2 hours',
  serviceArea: 'Taxi rides, parcels, bookings, payments, and account help',
  availability: 'Available every day, all day',
};

const toDialable = (value = '') => String(value).replace(/[^\d+]/g, '');

export function useSupportInfo() {
  const { contact, about } = useLandingContent();

  const phone = contact?.tollFree || contact?.whatsappDisplay || '';
  const owner = (about?.founders || []).find((f) => f?.name) || {};

  return {
    ...STATIC_DETAILS,
    ownerName: owner.name || '',
    ownerRole: owner.role || '',
    whatsappDisplay: contact?.whatsappDisplay || phone,
    phone,
    // wa/tel links need the punctuation stripped; fall back to the dial-format
    // WhatsApp number when no toll-free line is configured yet.
    phoneHref: toDialable(contact?.tollFree) || contact?.whatsapp || toDialable(phone),
    email: contact?.email || '',
    officeAddress: contact?.address || '',
    // wa.me format: country code, digits only.
    whatsapp: contact?.whatsapp || '',
  };
}
