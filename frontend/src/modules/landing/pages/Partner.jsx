import { useLanding } from '../landingContentContext';
import useEnquiryForm from '../useEnquiryForm';
import { LANDING_ICONS } from '../useLandingContent';
import React, { useRef, useState } from 'react';
import { Car, DollarSign, Award, ShieldCheck, CheckCircle2, ArrowRight } from 'lucide-react';
import useReveal from '../hooks/useReveal';

const Partner = () => {
  const { partnerPage } = useLanding();
  const partnerPerks = (partnerPage.perks || []).map((item) => ({
    ...item,
    icon: LANDING_ICONS[item.icon] || Award,
  }));

  const pageRef = useRef(null);
  useReveal(pageRef);

  const { submitted, sending, error, submit } = useEnquiryForm('partner');
  const [vehicleType, setVehicleType] = useState('Sedan (Dzire/Etios)');
  const [city, setCity] = useState('Bengaluru');
  const [ownerName, setOwnerName] = useState('');
  const [mobile, setMobile] = useState('');

  const handleSubmit = (e) => {
    submit(e, {
      name: ownerName,
      phone: mobile,
      city,
      vehicleCategory: vehicleType,
    });
  };

  return (
    <div className="partner-page animate-fade-in" ref={pageRef}>
      <div className="page-hero">
        <div className="container">
          <span className="page-tag">{partnerPage.tag}</span>
          <h1 className="page-title">{partnerPage.title}</h1>
          <p className="page-subtitle">
            Attach your commercial vehicle to India's fastest growing premium cab platform and earn up to ₹90,000/month per vehicle.
          </p>
        </div>
      </div>

      <section className="section-padding">
        <div className="container partner-grid">
          {/* Left Info & Earnings Estimator */}
          <div className="partner-info">
            <h2 className="section-title">{partnerPage.perksHeading}</h2>
            
            <div className="partner-perks-grid" data-reveal-stagger>
              {partnerPerks.map((perk, index) => {
                const PerkIcon = perk.icon;
                return (
                  <div className="perk-card" key={index}>
                    <PerkIcon size={28} color="#00BBA9" />
                    <h4>{perk.title}</h4>
                    <p>{perk.desc}</p>
                  </div>
                );
              })}
            </div>

            {/* Potential Earnings Table */}
            <div className="earnings-box mt-8">
              <h3 className="earnings-title">{partnerPage.earningsHeading}</h3>
              <div className="earnings-table">
                {(partnerPage.earnings || []).map((row, index) => (
                  <div className="e-row" key={index}>
                    <span>{row.label}</span>
                    <span className="e-val">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Attachment Form */}
          <div className="partner-form-card" data-reveal>
            <h3 className="form-card-title">{partnerPage.formTitle}</h3>
            <p className="form-card-sub">{partnerPage.formSubtitle}</p>

            {submitted ? (
              <div className="form-success text-center py-6">
                <CheckCircle2 size={50} color="#00BBA9" className="mx-auto mb-4" />
                <h4 className="text-xl font-bold text-white mb-2">Application Received!</h4>
                <p className="text-gray-300 text-sm">
                  Our Fleet Onboarding officer will call <strong>{mobile}</strong> to verify your vehicle documents.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="c-form">
                <div className="input-group">
                  <label>Vehicle Owner Name</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="Enter your full name"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Mobile Number (WhatsApp Enabled)</label>
                  <input 
                    type="tel" 
                    required 
                    placeholder="+91 98765 43210"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                  />
                </div>

                <div className="input-group">
                  <label>Operating City</label>
                  <select value={city} onChange={(e) => setCity(e.target.value)}>
                    <option value="Bengaluru">Bengaluru</option>
                    <option value="Mumbai">Mumbai</option>
                    <option value="Delhi NCR">Delhi NCR</option>
                    <option value="Hyderabad">Hyderabad</option>
                    <option value="Chennai">Chennai</option>
                  </select>
                </div>

                <div className="input-group">
                  <label>Vehicle Category</label>
                  <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                    <option value="Sedan (Dzire/Etios)">Sedan (Dzire / Etios)</option>
                    <option value="MUV (Ertiga)">MUV (Ertiga / Triber)</option>
                    <option value="SUV (Innova Crysta)">SUV (Innova Crysta)</option>
                    <option value="Luxury (Fortuner)">Luxury (Toyota Fortuner)</option>
                  </select>
                </div>

                {error && (
                  <p style={{ color: '#e11d48', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>
                )}
                <button type="submit" className="btn btn-teal w-full mt-4" disabled={sending}>
                  {sending ? 'Sending\u2026' : 'Submit Attachment Form'} <ArrowRight size={16} />
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          .partner-grid {
            display: grid;
            grid-template-columns: 1.1fr 0.9fr;
            gap: 50px;
            align-items: start;
          }

          .partner-perks-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-top: 20px;
          }

          .perk-card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 12px;
            padding: 20px;
          }

          .perk-card h4 {
            font-size: 15px;
            font-weight: 700;
            color: #0F172A;
            margin: 10px 0 6px;
          }

          .perk-card p {
            font-size: 13px;
            color: #64748B;
            line-height: 1.5;
          }

          .earnings-box {
            background: #07152B;
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 12px;
            padding: 20px;
            color: #FFFFFF;
          }

          .earnings-title {
            font-size: 16px;
            font-weight: 700;
            color: #00BBA9;
            margin-bottom: 14px;
          }

          .earnings-table {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          .e-row {
            display: flex;
            justify-content: space-between;
            font-size: 13.5px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding-bottom: 8px;
          }

          .e-val {
            color: #00BBA9;
            font-weight: 700;
          }

          .partner-form-card {
            background: #0C1B30;
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 16px;
            padding: 32px;
            color: #FFFFFF;
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.3);
          }

          @media (max-width: 992px) {
            .partner-grid {
              grid-template-columns: 1fr;
              gap: 34px;
            }
            .partner-perks-grid {
              grid-template-columns: 1fr;
            }
          }

          @media (max-width: 640px) {
            .partner-form-card {
              padding: 20px 18px;
            }
          }
      
        }
      `}</style>
    </div>
  );
};

export default Partner;
