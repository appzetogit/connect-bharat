import React, { useRef, useState } from 'react';
import {
  Smartphone, Globe, Car, Image, CheckCircle2, Gift, BellRing,
  Building2, ShoppingBag, UtensilsCrossed, HardHat, Stethoscope, GraduationCap,
  Send, TrendingUp, Users, MapPin
} from 'lucide-react';
import useReveal from '../hooks/useReveal';
import { useLanding } from '../landingContentContext';
import useEnquiryForm from '../useEnquiryForm';
import { LANDING_ICONS } from '../useLandingContent';

const Advertise = () => {
  const { contact: CONTACT, launchCities: LAUNCH_CITIES } = useLanding();
  const pageRef = useRef(null);
  useReveal(pageRef);

  const { submitted, sending, error, submit } = useEnquiryForm('advertise');
  const [company, setCompany] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [interest, setInterest] = useState('Mobile App Banners');
  const [brief, setBrief] = useState('');

  const handleSubmit = (e) => {
    submit(e, {
      name: contactName,
      phone,
      email,
      company,
      placement: interest,
      message: brief,
    });
  };

  const { advertisePage } = useLanding();
  const resolve = (items = [], fallbackIcon) =>
    items.map((item) => ({ ...item, icon: LANDING_ICONS[item.icon] || fallbackIcon }));
  const placements = resolve(advertisePage.placements, Smartphone);
  const industries = resolve(advertisePage.industries, Building2);
  // {cities} keeps the targeting line correct when a launch city changes.
  const whyUs = resolve(advertisePage.whyUs, Users).map((item) => ({
    ...item,
    desc: String(item.desc || '').replace('{cities}', LAUNCH_CITIES.map((c) => c.name).join(', ')),
  }));


  return (
    <div className="advertise-page animate-fade-in" ref={pageRef}>
      <div className="page-hero">
        <div className="container">
          <span className="page-tag">{advertisePage.tag}</span>
          <h1 className="page-title">{advertisePage.title}</h1>
          <p className="page-subtitle">
            Every Connect Bharat trip is a captive screen moment. Put your brand in front of riders and
            driver-partners across our app, website and driver network in Bengaluru, Mangaluru and Hubballi.
          </p>
        </div>
      </div>

      {/* Why advertise */}
      <section className="section-padding why-ad-section">
        <div className="container">
          <div className="why-ad-grid" data-reveal-stagger>
            {whyUs.map((w, i) => {
              const Icon = w.icon;
              return (
                <div key={i} className="why-ad-card">
                  <div className="why-ad-icon"><Icon size={22} color="#00BBA9" /></div>
                  <h3>{w.title}</h3>
                  <p>{w.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Ad placements */}
      <section className="section-padding placements-section">
        <div className="container">
          <div className="text-center mb-12">
            <span className="page-tag">Inventory</span>
            <h2 className="section-title">{advertisePage.inventoryHeading}</h2>
          </div>

          <div className="placements-grid" data-reveal-stagger>
            {placements.map((p, i) => {
              const Icon = p.icon;
              return (
                <div key={i} className="placement-card">
                  <div className="pl-icon"><Icon size={22} color="#00BBA9" /></div>
                  <h3 className="pl-title">{p.title}</h3>
                  <p className="pl-desc">{p.desc}</p>
                  <div className="pl-formats">
                    {p.formats.map((f, fi) => (
                      <span key={fi} className="pl-format">{f}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Industries */}
      <section className="section-padding industries-section">
        <div className="container">
          <div className="text-center mb-12">
            <span className="page-tag">Who Advertises With Us</span>
            <h2 className="section-title light">{advertisePage.industriesHeading}</h2>
          </div>

          <div className="industries-grid" data-reveal-stagger>
            {industries.map((ind, i) => {
              const Icon = ind.icon;
              return (
                <div key={i} className="industry-card">
                  <Icon size={22} color="#00BBA9" />
                  <span>{ind.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Enquiry form */}
      <section className="section-padding ad-form-section">
        <div className="container ad-form-grid">
          <div>
            <h2 className="section-title">{advertisePage.mediaKitHeading}</h2>
            <p className="ad-form-lead">
              Tell us your business and target city — we'll send placement options, available slots
              and pricing within one working day.
            </p>

            <div className="ad-contact-list">
              <div className="ad-contact-item">
                <strong>Email</strong>
                <a href={`mailto:${CONTACT.email}?subject=Advertising%20Enquiry`}>{CONTACT.email}</a>
              </div>
              <div className="ad-contact-item">
                <strong>Phone</strong>
                <span>{CONTACT.tollFree}</span>
              </div>
              <div className="ad-contact-item">
                <strong>Office</strong>
                <span>{CONTACT.address}</span>
              </div>
            </div>
          </div>

          <div className="ad-form-card" data-reveal>
            {submitted ? (
              <div className="ad-success">
                <CheckCircle2 size={50} color="#00BBA9" />
                <h3>Enquiry Received</h3>
                <p>
                  Thanks, <strong>{contactName || 'there'}</strong>. Our ad sales team will contact{' '}
                  <strong>{phone}</strong> with the Connect Bharat media kit.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="ad-form">
                <h3 className="ad-form-title">{advertisePage.formTitle}</h3>

                <div className="ad-field">
                  <label htmlFor="ad-company">Business / Brand Name</label>
                  <input
                    id="ad-company"
                    type="text"
                    required
                    placeholder="e.g. Grand Majestic Mall"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </div>

                <div className="ad-field-row">
                  <div className="ad-field">
                    <label htmlFor="ad-name">Contact Person</label>
                    <input
                      id="ad-name"
                      type="text"
                      required
                      placeholder="Full name"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                    />
                  </div>
                  <div className="ad-field">
                    <label htmlFor="ad-phone">Mobile Number</label>
                    <input
                      id="ad-phone"
                      type="tel"
                      required
                      placeholder="+91 98765 43210"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                </div>

                <div className="ad-field">
                  <label htmlFor="ad-email">Work Email</label>
                  <input
                    id="ad-email"
                    type="email"
                    required
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div className="ad-field">
                  <label htmlFor="ad-interest">Interested Placement</label>
                  <select
                    id="ad-interest"
                    value={interest}
                    onChange={(e) => setInterest(e.target.value)}
                  >
                    {placements.map((p) => (
                      <option key={p.title} value={p.title}>{p.title}</option>
                    ))}
                    <option value="Full Package">Full Package / Not sure yet</option>
                  </select>
                </div>

                <div className="ad-field">
                  <label htmlFor="ad-brief">Campaign Brief</label>
                  <textarea
                    id="ad-brief"
                    rows={4}
                    placeholder="Target city, campaign duration, budget range..."
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                  />
                </div>

                {error && (
                  <p style={{ color: '#e11d48', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>
                )}
                <button type="submit" className="btn btn-teal w-full" disabled={sending}>
                  {sending ? 'Sending\u2026' : 'Send Enquiry'} <Send size={16} />
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          .why-ad-section { background: #FFFFFF; }

          .why-ad-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 24px;
          }

          .why-ad-card {
            background: #F8FAFC;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 26px 22px;
          }

          .why-ad-icon {
            width: 46px;
            height: 46px;
            background: #E6F8F6;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 14px;
          }

          .why-ad-card h3 {
            font-size: 16.5px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 8px;
          }

          .why-ad-card p {
            font-size: 13.5px;
            color: #64748B;
            line-height: 1.6;
          }

          .placements-section { background: #F5F7FA; }

          .placements-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 22px;
          }

          .placement-card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 24px 22px;
            transition: var(--transition);
          }

          .placement-card:hover {
            border-color: #00BBA9;
            transform: translateY(-5px);
            box-shadow: var(--shadow-md);
          }

          .pl-icon {
            width: 44px;
            height: 44px;
            background: rgba(0, 187, 169, 0.1);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 14px;
          }

          .pl-title {
            font-size: 17px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 8px;
          }

          .pl-desc {
            font-size: 13.5px;
            color: #64748B;
            line-height: 1.6;
            margin-bottom: 14px;
          }

          .pl-formats {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
          }

          .pl-format {
            font-size: 11.5px;
            font-weight: 500;
            color: #334155;
            background: #F1F5F9;
            border: 1px solid #E2E8F0;
            border-radius: 20px;
            padding: 4px 11px;
          }

          .industries-section {
            background: linear-gradient(135deg, #07152B 0%, #0B1F3A 100%);
          }

          .industries-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 18px;
          }

          .industry-card {
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 12px;
            padding: 18px 20px;
            color: #FFFFFF;
            font-size: 14.5px;
            font-weight: 600;
            transition: var(--transition);
          }

          .industry-card:hover {
            border-color: #00BBA9;
            transform: translateY(-3px);
          }

          .ad-form-section { background: #FFFFFF; }

          .ad-form-grid {
            display: grid;
            grid-template-columns: 0.9fr 1.1fr;
            gap: 44px;
            align-items: start;
          }

          .ad-form-lead {
            font-size: 15px;
            color: #475569;
            line-height: 1.7;
            margin: 12px 0 24px;
          }

          .ad-contact-list {
            display: flex;
            flex-direction: column;
            gap: 14px;
          }

          .ad-contact-item {
            display: flex;
            flex-direction: column;
            gap: 3px;
            background: #F8FAFC;
            border: 1px solid #E2E8F0;
            border-left: 3px solid #00BBA9;
            border-radius: 10px;
            padding: 12px 16px;
          }

          .ad-contact-item strong {
            font-size: 11.5px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #64748B;
          }

          .ad-contact-item a, .ad-contact-item span {
            font-size: 14.5px;
            font-weight: 600;
            color: #0F172A;
          }

          .ad-contact-item a:hover { color: #00BBA9; }

          .ad-form-card {
            background: #0C1B30;
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 16px;
            padding: 32px;
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.25);
          }

          .ad-form-title {
            font-size: 20px;
            font-weight: 700;
            color: #FFFFFF;
            margin-bottom: 6px;
          }

          .ad-form {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }

          .ad-field-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
          }

          .ad-field {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }

          .ad-field label {
            font-size: 12.5px;
            font-weight: 500;
            color: #94A3B8;
          }

          .ad-field input, .ad-field select, .ad-field textarea {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 8px;
            padding: 11px 13px;
            color: #FFFFFF;
            font-size: 14px;
            outline: none;
            resize: vertical;
          }

          .ad-field input:focus, .ad-field select:focus, .ad-field textarea:focus {
            border-color: #00BBA9;
          }

          .ad-field input::placeholder, .ad-field textarea::placeholder {
            color: #64748B;
          }

          .ad-field select option {
            background: #0C1B30;
          }

          .ad-success {
            text-align: center;
            color: #FFFFFF;
            padding: 30px 0;
          }

          .ad-success h3 {
            font-size: 21px;
            font-weight: 700;
            margin: 14px 0 8px;
          }

          .ad-success p {
            font-size: 14px;
            color: #CBD5E1;
            line-height: 1.6;
          }

          @media (max-width: 992px) {
            .why-ad-grid, .industries-grid {
              grid-template-columns: 1fr 1fr;
            }
            .ad-form-grid {
              grid-template-columns: 1fr;
            }
          }

          @media (max-width: 640px) {
            .why-ad-grid, .industries-grid, .ad-field-row {
              grid-template-columns: 1fr;
            }
            .ad-form-card {
              padding: 22px;
            }
          }
      
        }
      `}</style>
    </div>
  );
};

export default Advertise;
