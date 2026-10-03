import { getRiderCorporateProfile } from '../services/corporateBookingService.js';

/// GET /users/me/corporate — tells the rider app whether to offer
/// "Bill to company" and what the company's rules are.
export const getMyCorporate = async (req, res) => {
  res.json({ success: true, data: await getRiderCorporateProfile({ userId: req.auth.sub }) });
};
