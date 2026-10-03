import { useLanding } from '../landingContentContext';
import useEnquiryForm from '../useEnquiryForm';
import { LANDING_ICONS } from '../useLandingContent';
import React, { useRef, useState } from 'react';
import { Briefcase, Building, FileText, UserCheck, ShieldCheck, CheckCircle2, Send, PhoneCall } from 'lucide-react';
import useReveal from '../hooks/useReveal';

const Corporate = () => {
  const pageRef = useRef(null);
  useReveal(pageRef);

  const { submitted, sending, error, submit } = useEnquiryForm('corporate');
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [monthlyRides, setMonthlyRides] = useState('50-200 Rides');

  const handleSubmit = (e) => {
    submit(e, {
      name: contactPerson,
      email,
      phone,
      company: companyName,
      monthlyRides,
    });
  };

  const { corporatePage } = useLanding();
  const corporateBenefits = (corporatePage.benefits || []).map((item) => ({
    ...item,
    icon: LANDING_ICONS[item.icon] || FileText,
  }));


  return (
    <div className="corporate-page animate-fade-in" ref={pageRef}>
      <div className="page-hero">
        <div className="container">
          <span className="page-tag">{corporatePage.tag}</span>
          <h1 className="page-title">{corporatePage.title}</h1>
          <p className="page-subtitle">{corporatePage.subtitle}</p>
        </div>
      </div>

      <section className="section-padding">
        <div className="container corp-grid">
          {/* Left Info */}
          <div className="corp-info">
            <h2 className="section-title">{corporatePage.benefitsHeading}</h2>
            <p className="body-text">
              Managing corporate travel expenses and ensuring employee safety can be challenging. Connect Bharat simplifies B2B travel with automated booking tools, zero surge pricing, and customized billing contracts.
            </p>

            <div className="benefits-column">
              {corporateBenefits.map((b, i) => {
                const Icon = b.icon;
                return (
                  <div key={i} className="b-item">
                    <div className="b-icon">
                      <Icon size={22} color="#00BBA9" />
                    </div>
                    <div>
                      <h4 className="b-title">{b.title}</h4>
                      <p className="b-desc">{b.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Form Card */}
          <div className="corp-form-card" data-reveal>
            <h3 className="form-card-title">{corporatePage.formTitle}</h3>
            <p className="form-card-sub">{corporatePage.formSubtitle}</p>

            {submitted ? (
              <div className="form-success text-center py-6">
                <CheckCircle2 size={50} color="#00BBA9" className="mx-auto mb-4" />
                <h4 className="text-xl font-bold text-white mb-2">Inquiry Submitted!</h4>
                <p className="text-gray-300 text-sm">
                  Our Corporate Account Manager will contact <strong>{contactPerson}</strong> at <strong>{email}</strong> shortly.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="c-form">
                <div className="input-group">
                  <label>Company / Enterprise Name</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. Infosys / TCS / Accenture"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Contact Person Name</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. Rahul Sharma"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Work Email Address</label>
                  <input 
                    type="email" 
                    required 
                    placeholder="rahul@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Phone Number</label>
                  <input 
                    type="tel" 
                    required 
                    placeholder="+91 98765 43210"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Estimated Monthly Rides</label>
                  <select value={monthlyRides} onChange={(e) => setMonthlyRides(e.target.value)}>
                    <option value="10-50 Rides">10 - 50 Rides / month</option>
                    <option value="50-200 Rides">50 - 200 Rides / month</option>
                    <option value="200+ Rides">200+ Rides / month</option>
                  </select>
                </div>

                {error && (
                  <p style={{ color: '#e11d48', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>
                )}
                <button type="submit" className="btn btn-teal w-full mt-4" disabled={sending}>
                  {sending ? 'Sending\u2026' : 'Submit Corporate Inquiry'} <Send size={16} />
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          .corp-grid {
            display: grid;
            grid-template-columns: 1.1fr 0.9fr;
            gap: 50px;
            align-items: start;
          }

          .benefits-column {
            display: flex;
            flex-direction: column;
            gap: 20px;
            margin-top: 24px;
          }

          .b-item {
            display: flex;
            gap: 16px;
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            padding: 18px;
            border-radius: 12px;
          }

          .b-icon {
            width: 44px;
            height: 44px;
            background: rgba(0, 187, 169, 0.1);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .b-title {
            font-size: 16px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 4px;
          }

          .b-desc {
            font-size: 13.5px;
            color: #64748B;
            line-height: 1.5;
          }

          .corp-form-card {
            background: #0C1B30;
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 16px;
            padding: 32px;
            color: #FFFFFF;
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.3);
          }

          .form-card-title {
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 4px;
          }

          .form-card-sub {
            font-size: 13.5px;
            color: #94A3B8;
            margin-bottom: 24px;
          }

          .c-form {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }

          @media (max-width: 992px) {
            .corp-grid {
              grid-template-columns: 1fr;
              gap: 34px;
            }
          }

          @media (max-width: 640px) {
            .corp-form-card {
              padding: 20px 18px;
            }
          }
      
        }
      `}</style>
    </div>
  );
};

export default Corporate;
