import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { GripVertical, Loader2, Plus, Save, Trash2, Upload, X } from 'lucide-react';
import { adminService } from '../../services/adminService';
import { uploadService } from '../../../../shared/services/uploadService';

/**
 * Editor for the public marketing site (bharat.buytogetherindia.com).
 *
 * Mirrors the backend's section whitelist in landingContentService.js — adding a
 * section means updating the model, that whitelist, defaultLandingContent.js and
 * the frontend's landingFallback.js, then adding a SECTION entry here.
 *
 * Saves send only the sections that changed, because the API treats the body as
 * a partial and an accidental empty array would blank a section on the site.
 */

// Must stay in step with the ICONS map in modules/landing/useLandingContent.js —
// a name that is not in that map silently renders as a generic sparkle.
const ICON_OPTIONS = [
  'Award', 'BellRing', 'Bike', 'Briefcase', 'Building', 'Building2', 'Car',
  'CheckCircle2', 'Clock', 'Compass', 'DollarSign', 'FileText', 'Gift', 'Globe',
  'GraduationCap', 'HardHat', 'Headphones', 'HeartHandshake', 'Image', 'MapPin',
  'Navigation', 'PhoneCall', 'Plane', 'Shield', 'ShieldCheck', 'ShoppingBag',
  'Smartphone', 'Stethoscope', 'TrendingUp', 'UserCheck', 'Users',
  'UtensilsCrossed', 'Wallet',
];

const SECTIONS = [
  {
    key: 'services',
    title: 'Our Services',
    help: 'Fallback only — the home page shows the active App Modules instead, so these appear only if that list cannot be loaded.',
    itemLabel: 'service',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'Airport Ride' },
      { name: 'icon', label: 'Icon', type: 'icon' },
      { name: 'desc', label: 'Description', placeholder: 'On-time pickup & drop guaranteed', wide: true },
      { name: 'id', label: 'Slug', placeholder: 'airport', help: 'Lowercase, no spaces.' },
    ],
  },
  {
    key: 'valueProps',
    title: 'Why Choose Us',
    help: 'The "Why Choose Connect Bharat?" cards.',
    itemLabel: 'point',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'Verified & Trained Drivers' },
      { name: 'icon', label: 'Icon', type: 'icon' },
      { name: 'desc', label: 'Description', placeholder: 'Professional drivers for your safe journey.', wide: true },
    ],
  },
  {
    key: 'drivers',
    title: 'Meet Our Drivers',
    help: 'Driver spotlight cards. Without a photo the card shows the initials instead.',
    itemLabel: 'driver',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'Ramesh Kumar' },
      { name: 'photo', label: 'Photo', type: 'image' },
      { name: 'rating', label: 'Rating', placeholder: '4.9' },
      { name: 'trips', label: 'Trips', placeholder: '3,200+ trips' },
      { name: 'experience', label: 'Experience', placeholder: '8 years experience' },
      { name: 'vehicle', label: 'Vehicle', placeholder: 'Maruti Suzuki Dzire · KA 01 AB 1234', wide: true },
      { name: 'badge', label: 'Badge', placeholder: 'Top Driver', help: '"Top Driver" is highlighted.' },
      { name: 'city', label: 'City', placeholder: 'Bengaluru' },
    ],
  },
  {
    key: 'partners',
    title: 'Trusted By',
    help: 'Names in the scrolling partner strip.',
    itemLabel: 'partner',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'TAJ Hotels' },
      { name: 'subtitle', label: 'Subtitle', placeholder: 'HOTELS' },
    ],
  },
  {
    key: 'launchCities',
    title: 'Launch Cities',
    help: 'Shown under "Where You\'ll Find Us" and in the footer.',
    itemLabel: 'city',
    fields: [
      { name: 'name', label: 'City', placeholder: 'Mysuru' },
      { name: 'note', label: 'Note', placeholder: 'South Karnataka Operations', wide: true },
    ],
  },
];

const CONTACT_FIELDS = [
  { name: 'tollFree', label: 'Toll-Free Number', placeholder: '1800 200 9999' },
  { name: 'whatsappDisplay', label: 'WhatsApp (displayed)', placeholder: '+91 98765 00000' },
  { name: 'whatsapp', label: 'WhatsApp (dial format)', placeholder: '919876500000', help: 'Country code, digits only — used to build the wa.me link.' },
  { name: 'email', label: 'Email', placeholder: 'support@bharat.buytogetherindia.com' },
  { name: 'addressShort', label: 'Short Address', placeholder: 'Grand Majestic Mall, Gandhinagar, Bengaluru', wide: true },
  { name: 'address', label: 'Full Address', placeholder: 'Grand Majestic Mall, Gandhinagar, Bengaluru, Karnataka 560009', wide: true },
  { name: 'mapsUrl', label: 'Google Maps URL', placeholder: 'https://www.google.com/maps/search/?api=1&query=...', wide: true },
];

const ABOUT_FIELDS = [
  { name: 'tag', label: 'Page tag', placeholder: 'About Connect Bharat' },
  { name: 'title', label: 'Page title', placeholder: 'Redefining Premium Cab Services...' },
  { name: 'subtitle', label: 'Page subtitle', wide: true },
  { name: 'foundersTag', label: 'Founders tag', placeholder: 'Leadership' },
  { name: 'foundersHeading', label: 'Founders heading', placeholder: 'Meet the Founders' },
  { name: 'pillarsHeading', label: 'Pillars heading', placeholder: 'The Pillars of Connect Bharat', wide: true },
];

const SERVICES_PAGE_FIELDS = [
  { name: 'tag', label: 'Page tag', placeholder: 'Connect Bharat Offerings' },
  { name: 'title', label: 'Page title', placeholder: 'Comprehensive Mobility Services' },
  { name: 'subtitle', label: 'Page subtitle', wide: true },
  { name: 'ctaLabel', label: 'Card button label', placeholder: 'Book This Service' },
];

const HERO_FIELDS = [
  { name: 'titleLine1', label: 'Headline line 1', placeholder: 'Your Ride.' },
  { name: 'titleLine2', label: 'Headline line 2', placeholder: 'Our Priority.', help: 'Shown in the accent colour.' },
  { name: 'subtitle', label: 'Subtitle', placeholder: 'Premium rides, verified drivers...', wide: true },
  { name: 'primaryCta', label: 'Primary button', placeholder: 'Book a Ride' },
  { name: 'secondaryCta', label: 'Secondary button', placeholder: 'Download App' },
];

const SEO_FIELDS = [
  { name: 'title', label: 'Browser tab title', placeholder: 'Connect Bharat - Your Ride. Our Priority.', wide: true },
  { name: 'description', label: 'Search description', placeholder: 'Connect Bharat - city, outstation and airport cabs...', wide: true },
];

const FOOTER_FIELDS = [
  { name: 'description', label: 'About blurb', placeholder: 'Connect Bharat is a premium cab booking platform...', wide: true },
  { name: 'servicesHeading', label: 'Services column heading', placeholder: 'Cab Services' },
  { name: 'copyright', label: 'Copyright line', placeholder: '© 2026 Connect Bharat. All Rights Reserved.', wide: true },
];

const BRAND_FIELDS = [
  { name: 'logo', label: 'Logo', type: 'image', wide: true, help: 'Shown in the header, footer and intro screen. Leave empty to use the logo from General Settings.' },
  { name: 'wordmarkPrimary', label: 'Wordmark (first part)', placeholder: 'Connect' },
  { name: 'wordmarkSecondary', label: 'Wordmark (second part)', placeholder: 'Bharat' },
  { name: 'tagline', label: 'Tagline', placeholder: 'Your Ride. Our Priority.', wide: true },
  { name: 'appBlurb', label: 'App blurb', placeholder: 'Book rides in seconds...', wide: true },
  { name: 'playStoreUrl', label: 'Google Play URL', placeholder: 'https://play.google.com/store/apps/details?id=...', wide: true, help: 'Leave blank and the badge stays unclickable.' },
  { name: 'appStoreUrl', label: 'App Store URL', placeholder: 'https://apps.apple.com/app/...', wide: true },
  { name: 'playStoreQr', label: 'Play Store QR', type: 'image' },
  { name: 'appStoreQr', label: 'App Store QR', type: 'image' },
];

// Repeatable lists nested inside the hero and footer objects.
const NESTED_LISTS = [
  { section: 'hero', key: 'badges', title: 'Hero trust badges', itemLabel: 'badge',
    fields: [{ name: 'label', label: 'Label', placeholder: 'Verified Drivers' }, { name: 'icon', label: 'Icon', type: 'icon' }] },
  { section: 'footer', key: 'cabServices', title: 'Footer services list', itemLabel: 'service',
    fields: [{ name: 'label', label: 'Label', placeholder: 'Airport Pickup & Drop', wide: true }] },
  { section: 'footer', key: 'trustPills', title: 'Footer trust pills', itemLabel: 'pill',
    fields: [{ name: 'label', label: 'Label', placeholder: 'Verified Drivers', wide: true }] },
];

const PAGE_LISTS = [
  { section: 'about', key: 'founders', title: 'Founders', itemLabel: 'founder',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'Full name' },
      { name: 'role', label: 'Role', placeholder: 'Co-Founder & COO' },
      { name: 'photo', label: 'Photo', type: 'image', wide: true, help: 'Square crop. Without one the card shows initials.' },
      { name: 'bio', label: 'Bio', placeholder: 'Two to three lines.', wide: true },
      { name: 'linkedin', label: 'LinkedIn URL', placeholder: 'https://linkedin.com/in/...', wide: true },
    ] },
  { section: 'about', key: 'stats', title: 'About page stats', itemLabel: 'stat',
    fields: [
      { name: 'label', label: 'Label', placeholder: 'Successful Rides' },
      { name: 'count', label: 'Number', placeholder: '100000', help: 'Counts up on scroll. Leave blank and use Value instead.' },
      { name: 'suffix', label: 'Suffix', placeholder: '+' },
      { name: 'value', label: 'Value (text)', placeholder: '4.9 \u2605', help: 'Used when Number is blank.' },
    ] },
  { section: 'about', key: 'pillars', title: 'About page pillars', itemLabel: 'pillar',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'Safety First' },
      { name: 'icon', label: 'Icon', type: 'icon' },
      { name: 'desc', label: 'Description', wide: true },
    ] },
  { section: 'servicesPage', key: 'items', title: 'Services page cards', itemLabel: 'service',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'Airport Transfer' },
      { name: 'tag', label: 'Badge', placeholder: 'Pickup & Drop Guarantee' },
      { name: 'icon', label: 'Icon', type: 'icon' },
      { name: 'id', label: 'Slug', placeholder: 'airport' },
      { name: 'image', label: 'Image', type: 'image', wide: true },
      { name: 'description', label: 'Description', wide: true },
      { name: 'features', label: 'Features (one per line)', type: 'lines', wide: true, placeholder: 'Flight delay tracking' },
    ] },
];

const MARKETING_PAGES = [
  { key: 'corporatePage', title: 'Corporate Page', help: 'Headings and form copy on /corporate.',
    fields: [
      { name: 'tag', label: 'Page tag' }, { name: 'title', label: 'Page title' },
      { name: 'subtitle', label: 'Page subtitle', wide: true },
      { name: 'benefitsHeading', label: 'Benefits heading', wide: true },
      { name: 'formTitle', label: 'Form title' }, { name: 'formSubtitle', label: 'Form subtitle' },
    ] },
  { key: 'partnerPage', title: 'Partner Page', help: 'Headings and form copy on /partner.',
    fields: [
      { name: 'tag', label: 'Page tag' }, { name: 'title', label: 'Page title' },
      { name: 'perksHeading', label: 'Perks heading', wide: true },
      { name: 'earningsHeading', label: 'Earnings heading', wide: true },
      { name: 'formTitle', label: 'Form title' }, { name: 'formSubtitle', label: 'Form subtitle' },
    ] },
  { key: 'driverPage', title: 'Driver Page', help: 'Headings and form copy on /drive-with-us.',
    fields: [
      { name: 'tag', label: 'Page tag' }, { name: 'title', label: 'Page title' },
      { name: 'perksHeading', label: 'Perks heading' }, { name: 'docsHeading', label: 'Documents heading' },
      { name: 'formTitle', label: 'Form title' }, { name: 'formSubtitle', label: 'Form subtitle' },
    ] },
  { key: 'advertisePage', title: 'Advertise Page', help: 'Headings and form copy on /advertise.',
    fields: [
      { name: 'tag', label: 'Page tag' }, { name: 'title', label: 'Page title' },
      { name: 'inventoryHeading', label: 'Inventory heading' },
      { name: 'industriesHeading', label: 'Industries heading' },
      { name: 'mediaKitHeading', label: 'Media kit heading' }, { name: 'formTitle', label: 'Form title' },
    ] },
];

const MARKETING_LISTS = [
  { section: 'corporatePage', key: 'benefits', title: 'Corporate benefits', itemLabel: 'benefit',
    fields: [{ name: 'title', label: 'Title' }, { name: 'icon', label: 'Icon', type: 'icon' },
             { name: 'desc', label: 'Description', wide: true }] },
  { section: 'partnerPage', key: 'perks', title: 'Partner perks', itemLabel: 'perk',
    fields: [{ name: 'title', label: 'Title' }, { name: 'icon', label: 'Icon', type: 'icon' },
             { name: 'desc', label: 'Description', wide: true }] },
  { section: 'partnerPage', key: 'earnings', title: 'Partner earnings table', itemLabel: 'row',
    fields: [{ name: 'label', label: 'Vehicle' }, { name: 'value', label: 'Monthly range' }] },
  { section: 'driverPage', key: 'perks', title: 'Driver perks', itemLabel: 'perk',
    fields: [{ name: 'title', label: 'Title' }, { name: 'icon', label: 'Icon', type: 'icon' },
             { name: 'desc', label: 'Description', wide: true }] },
  { section: 'advertisePage', key: 'placements', title: 'Ad placements', itemLabel: 'placement',
    fields: [{ name: 'title', label: 'Title' }, { name: 'icon', label: 'Icon', type: 'icon' },
             { name: 'desc', label: 'Description', wide: true },
             { name: 'formats', label: 'Formats (one per line)', type: 'lines', wide: true }] },
  { section: 'advertisePage', key: 'industries', title: 'Advertiser industries', itemLabel: 'industry',
    fields: [{ name: 'label', label: 'Label' }, { name: 'icon', label: 'Icon', type: 'icon' }] },
  { section: 'advertisePage', key: 'whyUs', title: 'Why advertise with us', itemLabel: 'point',
    fields: [{ name: 'title', label: 'Title' }, { name: 'icon', label: 'Icon', type: 'icon' },
             { name: 'desc', label: 'Description', wide: true,
               help: 'Use {cities} to insert the launch city names automatically.' }] },
];

const LEGAL_DOCS = [
  { key: 'terms', title: 'Terms & Conditions', path: '/terms' },
  { key: 'privacy', title: 'Privacy Policy', path: '/privacy' },
  { key: 'refund', title: 'Refund & Cancellation', path: '/refund' },
];

const inputClass =
  'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 outline-none transition-colors shadow-sm';
const labelClass = 'block text-sm font-medium text-gray-700 mb-1.5';

const SectionCard = ({ title, help, children, action }) => (
  <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-6">
    <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="w-1 h-5 bg-yellow-400 rounded-full" />
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          {help && <p className="text-xs text-gray-500 mt-0.5">{help}</p>}
        </div>
      </div>
      {action}
    </div>
    <div className="p-6">{children}</div>
  </div>
);

const ImageField = ({ value, onChange }) => {
  const [uploading, setUploading] = useState(false);

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl.startsWith('data:image/')) {
        toast.error('Please choose an image file.');
        return;
      }
      setUploading(true);
      try {
        const result = await uploadService.uploadImage(dataUrl, 'landing');
        const url = result?.secureUrl || result?.url || result?.data?.url;
        if (!url) throw new Error('Upload did not return a URL');
        onChange(url);
        toast.success('Image uploaded');
      } catch (error) {
        toast.error(error?.response?.data?.message || 'Upload failed');
      } finally {
        setUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="w-14 h-14 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden shrink-0 flex items-center justify-center">
        {value ? (
          <img src={value} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-[10px] text-gray-400">None</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={value || ''}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/uploads/landing/... or paste a URL"
          className={inputClass}
        />
        <div className="flex items-center gap-2 mt-1.5">
          <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 cursor-pointer hover:text-gray-900">
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {uploading ? 'Uploading…' : 'Upload'}
            <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
          </label>
          {value && (
            <button type="button" onClick={() => onChange('')} className="text-xs text-gray-400 hover:text-rose-500">
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const Field = ({ field, value, onChange }) => (
  <div className={field.wide ? 'sm:col-span-2' : ''}>
    <label className={labelClass}>{field.label}</label>
    {field.type === 'icon' ? (
      <select value={value || ''} onChange={(event) => onChange(event.target.value)} className={inputClass}>
        <option value="">Default</option>
        {ICON_OPTIONS.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    ) : field.type === 'lines' ? (
      <textarea
        rows={4}
        value={Array.isArray(value) ? value.join('\n') : (value || '')}
        onChange={(event) => onChange(event.target.value.split('\n').map((line) => line.trim()).filter(Boolean))}
        placeholder={field.placeholder}
        className={inputClass}
      />
    ) : field.type === 'image' ? (
      <ImageField value={value} onChange={onChange} />
    ) : (
      <input
        type="text"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        className={inputClass}
      />
    )}
    {field.help && <p className="text-xs text-gray-500 mt-1">{field.help}</p>}
  </div>
);

const RepeatableSection = ({ section, items, onChange }) => {
  const list = Array.isArray(items) ? items : [];

  const updateItem = (index, name, value) => {
    const next = list.map((item, i) => (i === index ? { ...item, [name]: value } : item));
    onChange(next);
  };

  const removeItem = (index) => onChange(list.filter((_, i) => i !== index));

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const addItem = () => onChange([...list, Object.fromEntries(section.fields.map((f) => [f.name, '']))]);

  return (
    <SectionCard
      title={section.title}
      help={section.help}
      action={
        <button
          type="button"
          onClick={addItem}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-900 bg-yellow-400 hover:bg-yellow-500 rounded-lg px-3 py-1.5 transition-colors"
        >
          <Plus size={14} /> Add
        </button>
      }
    >
      {list.length === 0 ? (
        <p className="text-sm text-gray-500 italic">
          Nothing here yet. The website falls back to its built-in copy until you add {section.itemLabel} entries.
        </p>
      ) : (
        <div className="space-y-4">
          {list.map((item, index) => (
            <div key={index} className="border border-gray-200 rounded-lg p-4 relative bg-gray-50/50">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <GripVertical size={14} className="text-gray-300" />
                  {section.itemLabel} {index + 1}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                    className="text-xs px-2 py-1 text-gray-500 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed">↑</button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === list.length - 1}
                    className="text-xs px-2 py-1 text-gray-500 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed">↓</button>
                  <button type="button" onClick={() => removeItem(index)}
                    className="text-gray-400 hover:text-rose-500 p-1" aria-label={`Remove ${section.itemLabel} ${index + 1}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {section.fields.map((field) => (
                  <Field
                    key={field.name}
                    field={field}
                    value={item?.[field.name]}
                    onChange={(value) => updateItem(index, field.name, value)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
};

export default function LandingContent() {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminService.getLandingContent();
      const data = response?.data?.data || response?.data || {};
      setContent({
        services: data.services || [],
        valueProps: data.valueProps || [],
        drivers: data.drivers || [],
        partners: data.partners || [],
        launchCities: data.launchCities || [],
        contact: data.contact || {},
        legal: data.legal || {},
        brand: data.brand || {},
        about: data.about || {},
        servicesPage: data.servicesPage || {},
        corporatePage: data.corporatePage || {},
        partnerPage: data.partnerPage || {},
        driverPage: data.driverPage || {},
        advertisePage: data.advertisePage || {},
        faqs: data.faqs || [],
        seo: data.seo || {},
        footer: data.footer || {},
        hero: data.hero || {},
      });
      setDirty(false);
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Could not load website content');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Warn before losing edits — a full page of copy is expensive to retype.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const setSection = (key, value) => {
    setContent((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  };

  const emptySections = useMemo(
    () => SECTIONS.filter((section) => !(content?.[section.key] || []).length).map((section) => section.title),
    [content],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminService.updateLandingContent(content);
      toast.success('Website content saved');
      setDirty(false);
      await load();
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500 gap-2">
        <Loader2 size={18} className="animate-spin" /> Loading website content…
      </div>
    );
  }

  if (!content) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-600">Could not load website content.</p>
        <button type="button" onClick={load} className="mt-3 text-sm font-medium text-gray-900 bg-yellow-400 rounded-lg px-3 py-1.5">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Website Content</h1>
          <p className="text-sm text-gray-500 mt-1">
            Controls the public site at bharat.buytogetherindia.com. Changes appear within about a minute.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900 bg-yellow-400 hover:bg-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg px-4 py-2 transition-colors shrink-0"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {saving ? 'Saving…' : dirty ? 'Save Changes' : 'Saved'}
        </button>
      </div>

      {emptySections.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
          <X size={15} className="text-amber-500 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">
            <strong>{emptySections.join(', ')}</strong> {emptySections.length === 1 ? 'is' : 'are'} empty, so the
            website is showing built-in default copy there. Add entries to take control of {emptySections.length === 1 ? 'it' : 'them'}.
          </p>
        </div>
      )}

      {SECTIONS.map((section) => (
        <RepeatableSection
          key={section.key}
          section={section}
          items={content[section.key]}
          onChange={(value) => setSection(section.key, value)}
        />
      ))}

      <SectionCard title="About Page" help="Headings on /about.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {ABOUT_FIELDS.map((field) => (
            <Field key={field.name} field={field} value={content.about?.[field.name]}
              onChange={(value) => setSection('about', { ...content.about, [field.name]: value })} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Services Page" help="Headings on /services.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {SERVICES_PAGE_FIELDS.map((field) => (
            <Field key={field.name} field={field} value={content.servicesPage?.[field.name]}
              onChange={(value) => setSection('servicesPage', { ...content.servicesPage, [field.name]: value })} />
          ))}
        </div>
      </SectionCard>

      {PAGE_LISTS.map((list) => (
        <RepeatableSection
          key={`${list.section}.${list.key}`}
          section={{ title: list.title, itemLabel: list.itemLabel, fields: list.fields }}
          items={content[list.section]?.[list.key] || []}
          onChange={(next) => setSection(list.section, { ...content[list.section], [list.key]: next })}
        />
      ))}

      <RepeatableSection
        section={{
          title: 'FAQs',
          help: 'The accordion on the contact page.',
          itemLabel: 'question',
          fields: [
            { name: 'q', label: 'Question', wide: true },
            { name: 'a', label: 'Answer', wide: true },
          ],
        }}
        items={content.faqs || []}
        onChange={(next) => setSection('faqs', next)}
      />

      {MARKETING_PAGES.map((page) => (
        <SectionCard key={page.key} title={page.title} help={page.help}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {page.fields.map((field) => (
              <Field key={field.name} field={field} value={content[page.key]?.[field.name]}
                onChange={(value) => setSection(page.key, { ...content[page.key], [field.name]: value })} />
            ))}
          </div>
        </SectionCard>
      ))}

      <SectionCard title="Driver documents required" help="One document per line, shown on /drive-with-us.">
        <Field
          field={{ name: 'requiredDocs', label: 'Documents', type: 'lines', placeholder: 'Aadhaar Card & PAN Card' }}
          value={content.driverPage?.requiredDocs}
          onChange={(value) => setSection('driverPage', { ...content.driverPage, requiredDocs: value })}
        />
      </SectionCard>

      {MARKETING_LISTS.map((list) => (
        <RepeatableSection
          key={`${list.section}.${list.key}`}
          section={{ title: list.title, itemLabel: list.itemLabel, fields: list.fields }}
          items={content[list.section]?.[list.key] || []}
          onChange={(next) => setSection(list.section, { ...content[list.section], [list.key]: next })}
        />
      ))}

      <SectionCard title="Hero" help="The headline block at the top of the home page.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {HERO_FIELDS.map((field) => (
            <Field key={field.name} field={field} value={content.hero?.[field.name]}
              onChange={(value) => setSection('hero', { ...content.hero, [field.name]: value })} />
          ))}
        </div>
      </SectionCard>

      {NESTED_LISTS.map((list) => {
        const items = content[list.section]?.[list.key] || [];
        const onChange = (next) => setSection(list.section, { ...content[list.section], [list.key]: next });
        return (
          <RepeatableSection
            key={`${list.section}.${list.key}`}
            section={{ title: list.title, itemLabel: list.itemLabel, fields: list.fields }}
            items={items}
            onChange={onChange}
          />
        );
      })}

      <SectionCard title="Footer" help="Wording in the site footer.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {FOOTER_FIELDS.map((field) => (
            <Field key={field.name} field={field} value={content.footer?.[field.name]}
              onChange={(value) => setSection('footer', { ...content.footer, [field.name]: value })} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Search & Browser Tab" help="Applied when the page loads. Crawlers that do not run JavaScript still see the build-time copy.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {SEO_FIELDS.map((field) => (
            <Field key={field.name} field={field} value={content.seo?.[field.name]}
              onChange={(value) => setSection('seo', { ...content.seo, [field.name]: value })} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Brand & App" help="Logo, wordmark and the app-store links behind the download badges.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {BRAND_FIELDS.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={content.brand?.[field.name]}
              onChange={(value) => setSection('brand', { ...content.brand, [field.name]: value })}
            />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Legal Documents"
        help="Terms, Privacy and Refund pages. Leave a field blank to keep the copy currently built into the site."
      >
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs text-amber-800">
            These are the documents your customers are held to. Have them reviewed before saving — whatever
            you put here replaces what the site shows today.
          </p>
        </div>
        <div className="space-y-6">
          {LEGAL_DOCS.map((doc) => {
            const value = content.legal?.[doc.key] || {};
            const update = (field, next) =>
              setSection('legal', { ...content.legal, [doc.key]: { ...value, [field]: next } });

            return (
              <div key={doc.key} className="border border-gray-200 rounded-lg p-4 bg-gray-50/50">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">{doc.title}</h4>
                  <a
                    href={doc.path}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-gray-500 hover:text-gray-900 underline"
                  >
                    View page
                  </a>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className={labelClass}>Intro</label>
                    <textarea
                      rows={2}
                      value={value.intro || ''}
                      onChange={(event) => update('intro', event.target.value)}
                      placeholder="Short line shown under the heading"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Document text</label>
                    <textarea
                      rows={12}
                      value={value.body || ''}
                      onChange={(event) => update('body', event.target.value)}
                      placeholder="Paste the full document. Separate paragraphs with a blank line."
                      className={`${inputClass} font-mono text-xs leading-relaxed`}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {value.body
                        ? `${value.body.length.toLocaleString()} characters — this replaces the built-in text.`
                        : 'Empty — the site is showing its built-in copy for this page.'}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Contact Details" help="Used across the website — footer, contact page and the WhatsApp button.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {CONTACT_FIELDS.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={content.contact?.[field.name]}
              onChange={(value) => setSection('contact', { ...content.contact, [field.name]: value })}
            />
          ))}
          <div className="sm:col-span-2">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(content.contact?.tollFreeLive)}
                onChange={(event) => setSection('contact', { ...content.contact, tollFreeLive: event.target.checked })}
                className="rounded border-gray-300 text-yellow-400 focus:ring-yellow-400"
              />
              <span className="text-sm text-gray-700">Toll-free number is live</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">
              When off, the contact page shows “Number activation in progress” instead of “Free from any Indian number”.
            </p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
