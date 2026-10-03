import { env } from '../../../../config/env.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { sendEmail } from '../../services/mailService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { CorporateAdmin } from '../models/CorporateAdmin.js';
import { CorporateDepartment } from '../models/CorporateDepartment.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';
import { normalizeIndianPhone } from './corporatePolicyEngine.js';

/// Every notification here is best effort: a failed SMS or SMTP outage must
/// never fail the booking, approval or invite that triggered it. Each function
/// resolves with what it managed to send.

const SMS_INDIA_HUB_ENDPOINT = 'http://cloud.smsindiahub.in/vendorsms/pushsms.aspx';

const getAppName = async () => {
  try {
    const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('general.app_name').lean();
    return String(doc?.general?.app_name || 'Connect Bharat').trim();
  } catch {
    return 'Connect Bharat';
  }
};

const fillTemplate = (text, values) =>
  String(text || '').replace(/\{(\w+)\}/g, (_match, key) => (values[key] === undefined ? '' : String(values[key])));

/// Free-text SMS through SMS India Hub. `smsService.sendOtpSms` is bound to the
/// OTP DLT template, so it cannot carry an invite; this sends `text` under the
/// DLT template id the admin registered for it, and does nothing without one.
export const sendCorporateSms = async ({ phone, text, templateId }) => {
  const hub = env.sms?.indiaHub || {};
  const apiKey = hub.apiKeyOverride || hub.apiKey;
  const hasCredentials = apiKey || (hub.username && hub.password);
  const digits = normalizeIndianPhone(phone);

  if (!templateId || !hub.senderId || !hasCredentials || !/^\d{10}$/.test(digits)) {
    return { sent: false, reason: 'sms-not-configured' };
  }
  if (['1', 'true', 'yes', 'on'].includes(String(env.sms?.useDefaultOtp || '').toLowerCase())) {
    console.log('[corporate-sms] default-OTP mode, not sending:', digits, text);
    return { sent: false, reason: 'debug-mode' };
  }

  const payload = new URLSearchParams({
    sid: hub.senderId,
    msisdn: `91${digits}`,
    msg: text,
    fl: '0',
    gwid: '2',
    TemplateId: templateId,
  });
  if (apiKey) payload.set('APIKey', apiKey);
  else {
    payload.set('user', hub.username);
    payload.set('password', hub.password);
  }

  try {
    const response = await fetch(SMS_INDIA_HUB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });
    const body = (await response.text()).trim();
    const ok = response.ok && !/error|invalid|failed|reject/i.test(body);
    return { sent: ok, reason: ok ? '' : body.slice(0, 200) };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
};

const safely = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[corporate-notify] ${label} failed:`, error.message);
    return null;
  }
};

export const notifyRider = async ({ userId, title, body, data = {} }) => {
  if (!userId) return null;
  return safely('rider push', () =>
    sendPushNotificationToEntities({ userIds: [String(userId)], title, body, data }),
  );
};

/// Invite an employee: push if they already use the app, SMS if a DLT template
/// is configured, email if we have an address.
export const sendEmployeeInvite = async ({ employee, corporate }) => {
  const settings = await getCorporateSettings();
  const app = await getAppName();
  const values = { name: employee.name, company: corporate.name, app };
  const result = { push: false, sms: false, email: false };

  if (employee.userId) {
    const push = await notifyRider({
      userId: employee.userId,
      title: `${corporate.name} added you to corporate travel`,
      body: 'You can now bill trips to your company. Choose "Corporate" as the payment method.',
      data: { type: 'corporate_invite', corporateId: String(corporate._id) },
    });
    result.push = Boolean(push?.successCount || push?.sentCount);
  }

  if (isFlagOn(settings.invite_sms_enabled)) {
    const sms = await sendCorporateSms({
      phone: employee.phone,
      text: fillTemplate(settings.invite_sms_text, values),
      templateId: settings.invite_sms_template_id,
    });
    result.sms = sms.sent;
  }

  if (employee.email) {
    const mail = await safely('invite email', () =>
      sendEmail({
        to: employee.email,
        subject: `${corporate.name} has added you to ${app} corporate travel`,
        text: `${fillTemplate(settings.invite_sms_text, values)}\n\nRegistered mobile: ${employee.phone}`,
      }),
    );
    result.email = Boolean(mail && !mail.skipped);
  }

  return result;
};

/// Who may decide a trip: owners and admins of the company, approvers scoped
/// to the trip's department (or unscoped), and anyone the department lists.
export const findTripApprovers = async ({ corporateId, departmentId = null }) => {
  const department = departmentId
    ? await CorporateDepartment.findById(departmentId).select('approverIds').lean()
    : null;
  const listed = (department?.approverIds || []).map(String);

  const admins = await CorporateAdmin.find({ corporateId, active: true }).lean();
  return admins.filter((admin) => {
    if (listed.includes(String(admin._id))) return true;
    if (['owner', 'admin'].includes(admin.role)) return true;
    if (admin.role !== 'approver') return false;
    const scoped = (admin.departmentIds || []).map(String);
    return scoped.length === 0 || (departmentId && scoped.includes(String(departmentId)));
  });
};

export const notifyApproversOfTrip = async ({ tripRequest, corporate, employee }) => {
  const settings = await getCorporateSettings();
  const app = await getAppName();
  const approvers = await findTripApprovers({ corporateId: corporate._id, departmentId: tripRequest.departmentId });
  const values = {
    employee: employee?.name || 'An employee',
    service: tripRequest.serviceType,
    amount: tripRequest.billableAmount,
    app,
    company: corporate.name,
  };
  const subject = `Trip approval needed: ${values.employee} (Rs ${values.amount})`;
  const text = [
    `${values.employee} has requested a ${values.service} trip.`,
    `From: ${tripRequest.pickupAddress || '-'}`,
    `To: ${tripRequest.dropAddress || '-'}`,
    `Billable amount: Rs ${values.amount}`,
    tripRequest.reasons?.length ? `Needs approval because: ${tripRequest.reasons.join('; ')}` : '',
    tripRequest.expiresAt ? `Decide before ${new Date(tripRequest.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} or it will be cancelled.` : '',
  ].filter(Boolean).join('\n');

  let emailed = 0;
  let texted = 0;
  for (const approver of approvers) {
    if (isFlagOn(settings.approver_email_enabled) && approver.email) {
      const mail = await safely('approver email', () => sendEmail({ to: approver.email, subject, text }));
      if (mail && !mail.skipped) emailed += 1;
    }
    if (isFlagOn(settings.approver_sms_enabled) && approver.phone) {
      const sms = await sendCorporateSms({
        phone: approver.phone,
        text: fillTemplate(settings.approver_sms_text, values),
        templateId: settings.approver_sms_template_id,
      });
      if (sms.sent) texted += 1;
    }
  }

  return { approvers: approvers.length, emailed, texted };
};
