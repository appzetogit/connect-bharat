/// Pickup slot arithmetic. Pure: the slot list and offset come from the
/// logistics settings.
///
/// Slots are configured as local-time strings ("09:00-12:00") because that
/// is how an operator thinks about them; the server clock is UTC. Every
/// conversion goes through the configured offset (IST by default) so a slot
/// means the same wall-clock window wherever the server runs.

const SLOT_PATTERN = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

export const parseSlot = (slot = '') => {
  const match = String(slot || '').trim().match(SLOT_PATTERN);
  if (!match) return null;
  const [, sh, sm, eh, em] = match.map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  if (sh > 23 || eh > 24 || sm > 59 || em > 59 || endMinutes <= startMinutes) return null;
  return { label: String(slot).trim(), startMinutes, endMinutes };
};

/// UTC instant for a local date (YYYY-MM-DD) plus minutes after local midnight.
export const localToUtc = (dateString, minutes, offsetMinutes = 330) => {
  const [y, m, d] = String(dateString).split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  return new Date(Date.UTC(y, m - 1, d, 0, minutes) - offsetMinutes * 60 * 1000);
};

export const localDateString = (date = new Date(), offsetMinutes = 330) => {
  const shifted = new Date(new Date(date).getTime() + offsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
};

/// The slots on one local date, each marked available or not given the lead
/// time. Returns [] for a date outside the bookable window.
export const listPickupSlots = ({
  date,
  slots = [],
  offsetMinutes = 330,
  leadMinutes = 60,
  daysAhead = 7,
  now = new Date(),
}) => {
  const today = localDateString(now, offsetMinutes);
  const lastDay = localDateString(new Date(now.getTime() + daysAhead * 86400000), offsetMinutes);
  const target = date || today;
  if (target < today || target > lastDay) return [];
  const earliest = now.getTime() + Number(leadMinutes || 0) * 60000;

  return (Array.isArray(slots) ? slots : [])
    .map(parseSlot)
    .filter(Boolean)
    .map((slot) => {
      const startsAt = localToUtc(target, slot.startMinutes, offsetMinutes);
      const endsAt = localToUtc(target, slot.endMinutes, offsetMinutes);
      return {
        slot: slot.label,
        date: target,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        available: startsAt.getTime() >= earliest,
      };
    });
};

/// Validates a requested pickup ({date, slot}) and returns the UTC start
/// and end of the window, or throws with a message an app can show.
export const resolvePickupWindow = ({ date, slot, ...options }) => {
  const slots = listPickupSlots({ date, ...options });
  if (!slots.length) {
    throw new Error('Pickup date is outside the bookable window');
  }
  const match = slots.find((item) => item.slot === String(slot || '').trim());
  if (!match) {
    throw new Error(`Unknown pickup slot. Choose one of: ${slots.map((item) => item.slot).join(', ')}`);
  }
  if (!match.available) {
    throw new Error('That pickup slot is no longer available');
  }
  return { slot: match.slot, date: match.date, startsAt: new Date(match.startsAt), endsAt: new Date(match.endsAt) };
};
