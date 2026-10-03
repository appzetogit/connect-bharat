import React, { useRef, useState } from 'react';
import { Phone, Mail, MapPin, MessageSquare, ChevronDown, CheckCircle2, Send, Navigation } from 'lucide-react';
import useReveal from '../hooks/useReveal';
import { useLanding } from '../landingContentContext';
import useEnquiryForm from '../useEnquiryForm';

const ContactUs = () => {
  const { contact: CONTACT, launchCities: LAUNCH_CITIES, waLink, faqs } = useLanding();
  const pageRef = useRef(null);
  useReveal(pageRef);

  const { submitted, sending, error, submit } = useEnquiryForm('contact');
  const [openFaq, setOpenFaq] = useState(0);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = (e) => {
    submit(e, {
      name,
      email,
      subject,
      message,
    });
  };


  return (
    <div className="contact-page animate-fade-in" ref={pageRef}>
      <div className="page-hero">
        <div className="container">
          <span className="page-tag">24x7 Customer Helpdesk</span>
          <h1 className="page-title">We Are Here To Assist You</h1>
          <p className="page-subtitle">
            Have questions about ride bookings, corporate accounts, or fleet attachment? Connect with our dedicated support team anytime.
          </p>
        </div>
      </div>

      <section className="section-padding">
        <div className="container">
          {/* Top Contact Info Cards */}
          <div className="contact-cards-grid" data-reveal-stagger>
            <a className="c-info-card" href={`tel:${CONTACT.tollFree.replace(/\s/g, '')}`}>
              <div className="c-icon-wrap">
                <Phone size={24} color="#00BBA9" />
              </div>
              <h3>Call us</h3>
              <p>{CONTACT.tollFree}</p>
              <span>Calls and WhatsApp on the same number</span>
            </a>

            <a className="c-info-card" href={waLink('Hi Connect Bharat, I need help with a booking.')} target="_blank" rel="noreferrer">
              <div className="c-icon-wrap">
                <MessageSquare size={24} color="#00BBA9" />
              </div>
              <h3>WhatsApp Support</h3>
              <p>{CONTACT.whatsappDisplay}</p>
              <span>Chat, share live location & get fare</span>
            </a>

            <a className="c-info-card" href={`mailto:${CONTACT.email}`}>
              <div className="c-icon-wrap">
                <Mail size={24} color="#00BBA9" />
              </div>
              <h3>Official Email</h3>
              <p>{CONTACT.email}</p>
              <span>Response within 15 mins</span>
            </a>

            <a className="c-info-card" href={CONTACT.mapsUrl} target="_blank" rel="noreferrer">
              <div className="c-icon-wrap">
                <MapPin size={24} color="#00BBA9" />
              </div>
              <h3>Head Office</h3>
              <p>{CONTACT.addressShort}</p>
              <span>Open in Google Maps</span>
            </a>
          </div>

          {/* TOLL-FREE SUPPORT EXPLAINER - shown only once a real toll-free line
              with this IVR menu exists. The contact number today is an ordinary
              mobile: calling it free, or offering 'press 1 for a new booking',
              would promise a phone menu nobody would reach. */}
          {CONTACT.tollFreeLive && (
  <div className="tollfree-banner mt-12" data-reveal>
              <div className="tf-left">
                <span className="tf-tag">Toll-Free Support</span>
                <h2 className="tf-number">{CONTACT.tollFree}</h2>
                <p className="tf-desc">
                  One number for bookings, live ride help, lost items, invoices and complaints —
                  free of charge from any Indian mobile or landline, 24 hours a day.
                </p>
                <div className="tf-points">
                  <div className="tf-point"><CheckCircle2 size={16} color="#00BBA9" /> IVR in English, Kannada & Hindi</div>
                  <div className="tf-point"><CheckCircle2 size={16} color="#00BBA9" /> Routed to the nearest city support desk</div>
                  <div className="tf-point"><CheckCircle2 size={16} color="#00BBA9" /> Every call recorded for safety audits</div>
                  <div className="tf-point"><CheckCircle2 size={16} color="#00BBA9" /> Emergency/SOS calls answered on priority</div>
                </div>
              </div>
              <div className="tf-right">
                <div className="tf-ivr-card">
                  <h4>Call Menu</h4>
                  <ol className="tf-ivr-list">
                    <li><b>1</b> New booking / fare enquiry</li>
                    <li><b>2</b> Track or change an ongoing ride</li>
                    <li><b>3</b> Airport & outstation desk</li>
                    <li><b>4</b> Corporate & partner accounts</li>
                    <li><b>5</b> Complaint, refund or lost item</li>
                    <li><b>9</b> Emergency — connect to a human</li>
                  </ol>
                </div>
              </div>
            </div>
          )}

          {/* OFFICE LOCATION & LAUNCH CITIES */}
          <div className="office-grid mt-12" data-reveal-stagger>
            <div className="office-card">
              <h3 className="office-title"><MapPin size={18} color="#00BBA9" /> Our Office</h3>
              <p className="office-addr">{CONTACT.address}</p>
              <a className="btn btn-teal btn-office" href={CONTACT.mapsUrl} target="_blank" rel="noreferrer">
                <Navigation size={16} /> Get Directions
              </a>
            </div>
            <div className="office-card">
              <h3 className="office-title"><Navigation size={18} color="#00BBA9" /> Launch Cities</h3>
              <div className="city-list">
                {LAUNCH_CITIES.map((c) => (
                  <div key={c.name} className="city-row">
                    <span className="city-name">{c.name}</span>
                    <span className="city-note">{c.note}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Form & FAQ split */}
          <div className="contact-main-grid mt-12">
            {/* Form */}
            <div className="contact-form-box">
              <h2 className="section-title">Send Us a Message</h2>
              <p className="body-text mb-6">Fill out the form below and our team will get back to you immediately.</p>

              {submitted ? (
                <div className="form-success py-8 text-center">
                  <CheckCircle2 size={50} color="#00BBA9" className="mx-auto mb-3" />
                  <h3 className="text-xl font-bold text-gray-900 mb-1">Message Sent Successfully!</h3>
                  <p className="text-gray-600 text-sm">
                    Thank you, <strong>{name}</strong>. We have your message and will reply to <strong>{email}</strong>.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="c-main-form">
                  <div className="form-row">
                    <div className="input-group">
                      <label>Your Name</label>
                      <input 
                        type="text" 
                        required 
                        placeholder="John Doe"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="input-group">
                      <label>Email Address</label>
                      <input 
                        type="email" 
                        required 
                        placeholder="john@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="input-group">
                    <label>Subject</label>
                    <input 
                      type="text" 
                      required 
                      placeholder="e.g. Booking Assistance / Receipt Request"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                    />
                  </div>

                  <div className="input-group">
                    <label>Message</label>
                    <textarea 
                      rows={5} 
                      required 
                      placeholder="Describe your query in detail..."
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                  </div>

                  {error && (
                    <p style={{ color: '#e11d48', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>
                  )}
                  <button type="submit" className="btn btn-teal" disabled={sending}>
                    {sending ? 'Sending\u2026' : 'Send Message'} <Send size={16} />
                  </button>
                </form>
              )}
            </div>

            {/* FAQ Accordion */}
            <div className="faq-box">
              <h2 className="section-title mb-6">Frequently Asked Questions</h2>
              <div className="faq-accordion">
                {faqs.map((faq, index) => (
                  <div key={index} className={`faq-item ${openFaq === index ? 'open' : ''}`}>
                    <button 
                      className="faq-q-btn"
                      onClick={() => setOpenFaq(openFaq === index ? -1 : index)}
                    >
                      <span>{faq.q}</span>
                      <ChevronDown size={18} className="faq-chevron" />
                    </button>
                    {/* no animate-fade-in on the answer: .faq-item clips overflow,
                        so the animation's 12px offset cuts the text while it plays */}
                    {openFaq === index && (
                      <div className="faq-a-body">
                        <p>{faq.a}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          .contact-cards-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
          }

          .c-info-card {
            display: block;
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 14px;
            padding: 24px 18px;
            text-align: center;
            transition: var(--transition);
          }

          .c-info-card:hover {
            transform: translateY(-4px);
            border-color: #00BBA9;
            box-shadow: var(--shadow-md);
          }

          .c-icon-wrap {
            width: 50px;
            height: 50px;
            background: rgba(0, 187, 169, 0.1);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 14px;
          }

          .c-info-card h3 {
            font-size: 15px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 4px;
          }

          .c-info-card p {
            font-size: 15px;
            font-weight: 700;
            color: #00BBA9;
            margin-bottom: 4px;
          }

          .c-info-card span {
            font-size: 12px;
            color: #64748B;
          }

          .mt-12 {
            margin-top: 48px;
          }

          .contact-main-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 40px;
            align-items: start;
          }

          /* Toll-free explainer */
          .tollfree-banner {
            background: linear-gradient(135deg, #07152B 0%, #0B1F3A 100%);
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 18px;
            padding: 34px 38px;
            display: grid;
            grid-template-columns: 1.2fr 0.8fr;
            gap: 34px;
            align-items: center;
            color: #FFFFFF;
          }

          .tf-tag {
            display: inline-block;
            font-size: 11.5px;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
            color: #00BBA9;
            background: rgba(0, 187, 169, 0.12);
            padding: 4px 12px;
            border-radius: 20px;
            margin-bottom: 10px;
          }

          .tf-number {
            font-size: 38px;
            font-weight: 800;
            letter-spacing: 1px;
            margin-bottom: 8px;
          }

          .tf-desc {
            font-size: 14px;
            color: #94A3B8;
            line-height: 1.6;
            max-width: 520px;
            margin-bottom: 18px;
          }

          .tf-points {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }

          .tf-point {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: #CBD5E1;
          }

          .tf-ivr-card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 14px;
            padding: 20px 22px;
          }

          .tf-ivr-card h4 {
            font-size: 14px;
            font-weight: 700;
            color: #00BBA9;
            margin-bottom: 12px;
          }

          .tf-ivr-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 9px;
            font-size: 13px;
            color: #CBD5E1;
          }

          .tf-ivr-list b {
            display: inline-block;
            width: 22px;
            height: 22px;
            line-height: 22px;
            text-align: center;
            background: rgba(0, 187, 169, 0.15);
            color: #00BBA9;
            border-radius: 6px;
            margin-right: 8px;
            font-size: 12px;
          }

          /* Office + cities */
          .office-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
          }

          .office-card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 26px;
          }

          .office-title {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 17px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 12px;
          }

          .office-addr {
            font-size: 14.5px;
            color: #475569;
            line-height: 1.6;
            margin-bottom: 18px;
          }

          .btn-office {
            font-size: 14px;
            padding: 10px 20px;
          }

          .city-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          .city-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #F8FAFC;
            border: 1px solid #E2E8F0;
            border-radius: 10px;
            padding: 11px 14px;
          }

          .city-name {
            font-size: 14.5px;
            font-weight: 700;
            color: #0F172A;
          }

          .city-note {
            font-size: 12px;
            color: #64748B;
          }

          .contact-form-box {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 32px;
          }

          .c-main-form {
            display: flex;
            flex-direction: column;
            gap: 18px;
          }

          .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
          }

          .c-main-form label {
            font-size: 13px;
            font-weight: 600;
            color: #0F172A;
          }

          .c-main-form input, .c-main-form textarea {
            background: #F8FAFC;
            border: 1px solid #CBD5E1;
            border-radius: 8px;
            padding: 12px 14px;
            color: #0F172A;
            font-size: 14px;
            outline: none;
          }

          .c-main-form input:focus, .c-main-form textarea:focus {
            border-color: #00BBA9;
            background: #FFFFFF;
          }

          .faq-box {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 32px;
          }

          .faq-accordion {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .faq-item {
            border: 1px solid #E2E8F0;
            border-radius: 10px;
            overflow: hidden;
            transition: all 0.2s;
          }

          .faq-item.open {
            border-color: #00BBA9;
          }

          .faq-q-btn {
            width: 100%;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 18px;
            background: #F8FAFC;
            border: none;
            cursor: pointer;
            font-size: 14.5px;
            font-weight: 600;
            color: #0F172A;
            text-align: left;
          }

          .faq-chevron {
            transition: transform 0.2s;
          }

          .faq-item.open .faq-chevron {
            transform: rotate(180deg);
            color: #00BBA9;
          }

          .faq-a-body {
            padding: 16px 18px;
            font-size: 14px;
            color: #475569;
            line-height: 1.6;
            border-top: 1px solid #E2E8F0;
            background: #FFFFFF;
          }

          @media (max-width: 992px) {
            .contact-cards-grid {
              grid-template-columns: 1fr 1fr;
            }
            .contact-main-grid,
            .tollfree-banner,
            .office-grid {
              grid-template-columns: 1fr;
            }
            .tollfree-banner {
              padding: 26px 22px;
            }
          }

          @media (max-width: 576px) {
            .contact-cards-grid {
              grid-template-columns: 1fr;
            }
            .form-row,
            .tf-points {
              grid-template-columns: 1fr;
            }
            .tf-number {
              font-size: 30px;
            }
          }
      
        }
      `}</style>
    </div>
  );
};

export default ContactUs;
