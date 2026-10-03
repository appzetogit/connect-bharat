import React, { useRef } from 'react';
import { ShieldCheck, Award, Users, MapPin, HeartHandshake, CheckCircle2, ArrowRight, ExternalLink, Navigation } from 'lucide-react';
import useReveal from '../hooks/useReveal';
import { useLanding } from '../landingContentContext';
import { LANDING_ICONS } from '../useLandingContent';

const AboutUs = ({ openBookingModal }) => {
  const { contact: CONTACT, launchCities: LAUNCH_CITIES, about } = useLanding();
  const pageRef = useRef(null);
  useReveal(pageRef);

  const stats = about.stats || [];
  const founders = about.founders || [];
  // Icons are stored as names; resolve them the same way the home page does.
  const pillars = (about.pillars || []).map((pillar) => ({
    ...pillar,
    icon: LANDING_ICONS[pillar.icon] || ShieldCheck,
  }));

  return (
    <div className="about-page animate-fade-in" ref={pageRef}>
      {/* Page Header */}
      <div className="page-hero">
        <div className="container">
          <span className="page-tag">{about.tag}</span>
          <h1 className="page-title">{about.title}</h1>
          <p className="page-subtitle">{about.subtitle}</p>
        </div>
      </div>

      {/* Stats Counter Bar */}
      <section className="stats-section">
        <div className="container">
          <div className="stats-grid" data-reveal-stagger>
            {stats.map((s, i) => (
              <div key={i} className="stat-card">
                <span className="stat-value">
                  {s.count != null ? (
                    <>
                      {/* renders the final number, so it reads correctly if the
                          count-up never runs; the animation starts it from 0 */}
                      <span data-count={s.count}>{s.count.toLocaleString('en-IN')}</span>
                      {s.suffix}
                    </>
                  ) : (
                    s.value
                  )}
                </span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Story & Mission Section */}
      <section className="section-padding story-section">
        <div className="container story-grid">
          <div className="story-content" data-reveal>
            <h2 className="section-title">Our Story & Mission</h2>
            <p className="body-text">
              Connect Bharat was founded with a clear mission: to eliminate ride cancellations, surge pricing shocks, and unverified driver risks for travelers in Karnataka.
            </p>
            <p className="body-text">
              Whether you need an early morning 4 AM airport cab in Bengaluru, an executive sedan for corporate travel, or a family SUV for an outstation weekend trip to Coorg, Connect Bharat ensures guaranteed on-time pickup with professional drivers.
            </p>
            
            <div className="mission-list">
              <div className="m-item">
                <CheckCircle2 size={18} color="#00BBA9" />
                <span>100% Guaranteed On-Time Pickups</span>
              </div>
              <div className="m-item">
                <CheckCircle2 size={18} color="#00BBA9" />
                <span>Zero Cancellation Fees for Riders</span>
              </div>
              <div className="m-item">
                <CheckCircle2 size={18} color="#00BBA9" />
                <span>Clean, Sanitized & Premium Fleet</span>
              </div>
            </div>

            <button className="btn btn-teal mt-6" onClick={openBookingModal}>
              Book Your Ride Now <ArrowRight size={18} />
            </button>
          </div>

          <div className="story-image-box" data-reveal>
            <img 
              src="https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=800&q=80" 
              alt="Connect Bharat Premium Ride"
              className="story-img"
            />
            <div className="story-badge">
              <span className="badge-num">24x7</span>
              <span className="badge-txt">Live Coordination Support</span>
            </div>
          </div>
        </div>
      </section>

      {/* Founders Section */}
      <section className="section-padding founders-section">
        <div className="container">
          <div className="text-center mb-12">
            <span className="page-tag dark-tag">{about.foundersTag}</span>
            <h2 className="section-title">{about.foundersHeading}</h2>
          </div>

          <div className="founders-grid" data-reveal-stagger>
            {founders.map((f, i) => (
              <div key={i} className="founder-card">
                <div className="avatar founder-photo">
                  {f.name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
                  {/* Only with a photo. An <img src=""> is not an error to every
                      browser, so onError never hid it: the page drew a broken
                      picture with the name printed across the initials. */}
                  {f.photo && (
                    <img
                      src={f.photo}
                      alt={f.name}
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  )}
                </div>
                <div className="founder-body">
                  <h3 className="founder-name">{f.name}</h3>
                  <span className="founder-role">{f.role}</span>
                  <p className="founder-bio">{f.bio}</p>
                  {f.linkedin && (
                    <a href={f.linkedin} target="_blank" rel="noreferrer" className="founder-link">
                      <ExternalLink size={15} /> LinkedIn
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Office & Launch Cities */}
      <section className="section-padding presence-section">
        <div className="container">
          <div className="text-center mb-12">
            <span className="page-tag">Our Presence</span>
            <h2 className="section-title light">Office & Launch Cities</h2>
          </div>

          <div className="presence-grid">
            <div className="presence-office" data-reveal>
              <h3 className="presence-heading"><MapPin size={18} color="#00BBA9" /> Head Office</h3>
              <p className="presence-addr">{CONTACT.address}</p>
              <a className="btn btn-teal" href={CONTACT.mapsUrl} target="_blank" rel="noreferrer">
                <Navigation size={16} /> View on Google Maps
              </a>
            </div>

            <div className="presence-cities" data-reveal-stagger>
              {LAUNCH_CITIES.map((c) => (
                <div key={c.name} className="presence-city-card">
                  <MapPin size={20} color="#00BBA9" />
                  <h4>{c.name}</h4>
                  <span>{c.note}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Pillars Section */}
      <section className="section-padding pillars-section">
        <div className="container">
          <h2 className="section-title text-center mb-12">{about.pillarsHeading}</h2>
          
          <div className="pillars-grid" data-reveal-stagger>
            {pillars.map((p, idx) => {
              const Icon = p.icon;
              return (
                <div key={idx} className="pillar-card">
                  <div className="p-icon-wrap">
                    <Icon size={28} color="#00BBA9" />
                  </div>
                  <h3 className="p-title">{p.title}</h3>
                  <p className="p-desc">{p.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          .stats-section {
            background-color: #07152B;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding: 30px 0;
          }

          .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            text-align: center;
          }

          .stat-value {
            display: block;
            font-size: 36px;
            font-weight: 800;
            color: #00BBA9;
          }

          .stat-label {
            font-size: 13.5px;
            color: #94A3B8;
            font-weight: 500;
          }

          .story-section {
            background-color: #FFFFFF;
          }

          .story-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 50px;
            align-items: center;
          }

          .mission-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-top: 20px;
          }

          .m-item {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 14.5px;
            font-weight: 600;
            color: #0F172A;
          }

          .story-image-box {
            position: relative;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 20px 40px rgba(11, 31, 58, 0.15);
          }

          .story-img {
            width: 100%;
            height: 380px;
            object-fit: cover;
            display: block;
          }

          .story-badge {
            position: absolute;
            bottom: 20px;
            left: 20px;
            background: rgba(7, 21, 43, 0.9);
            backdrop-filter: blur(8px);
            border: 1px solid #00BBA9;
            padding: 12px 20px;
            border-radius: 12px;
            color: #FFFFFF;
          }

          .badge-num {
            display: block;
            font-size: 22px;
            font-weight: 800;
            color: #00BBA9;
          }

          .badge-txt {
            font-size: 12px;
            color: #CBD5E1;
          }

          /* Founders */
          .founders-section {
            background-color: #FFFFFF;
            border-top: 1px solid #E2E8F0;
          }

          .dark-tag {
            background: rgba(0, 187, 169, 0.1);
          }

          .founders-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 26px;
            max-width: 900px;
            margin: 0 auto;
          }

          .founder-card {
            display: flex;
            gap: 18px;
            background: #F8FAFC;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 22px;
            transition: var(--transition);
          }

          .founder-card:hover {
            border-color: #00BBA9;
            box-shadow: var(--shadow-md);
            transform: translateY(-4px);
          }

          .founder-photo {
            width: 96px;
            height: 96px;
            border-radius: 14px;
            font-size: 28px;
          }

          .founder-name {
            font-size: 17.5px;
            font-weight: 700;
            color: #0F172A;
          }

          .founder-role {
            display: block;
            font-size: 12.5px;
            font-weight: 600;
            color: #00BBA9;
            margin-bottom: 8px;
          }

          .founder-bio {
            font-size: 13.5px;
            color: #64748B;
            line-height: 1.6;
          }

          .founder-link {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 12.5px;
            font-weight: 600;
            color: #0F172A;
            margin-top: 10px;
          }

          .founder-link:hover {
            color: #00BBA9;
          }

          /* Presence */
          .presence-section {
            background: linear-gradient(135deg, #07152B 0%, #0B1F3A 100%);
            color: #FFFFFF;
          }

          .presence-grid {
            display: grid;
            grid-template-columns: 0.9fr 1.1fr;
            gap: 30px;
            align-items: center;
          }

          .presence-office {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 16px;
            padding: 28px;
          }

          .presence-heading {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 17px;
            font-weight: 700;
            color: #FFFFFF;
            margin-bottom: 12px;
          }

          .presence-addr {
            font-size: 14.5px;
            color: #CBD5E1;
            line-height: 1.65;
            margin-bottom: 20px;
          }

          .presence-cities {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 18px;
          }

          .presence-city-card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 14px;
            padding: 22px 16px;
            text-align: center;
            transition: var(--transition);
          }

          .presence-city-card:hover {
            border-color: #00BBA9;
            transform: translateY(-4px);
          }

          .presence-city-card h4 {
            font-size: 16px;
            font-weight: 700;
            color: #FFFFFF;
            margin: 10px 0 4px;
          }

          .presence-city-card span {
            font-size: 11.5px;
            color: #94A3B8;
          }

          .pillars-section {
            background-color: #F8FAFC;
          }

          .pillars-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 24px;
          }

          .pillar-card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            padding: 28px 20px;
            transition: var(--transition);
          }

          .pillar-card:hover {
            transform: translateY(-4px);
            border-color: #00BBA9;
            box-shadow: var(--shadow-md);
          }

          .p-icon-wrap {
            width: 52px;
            height: 52px;
            background: rgba(0, 187, 169, 0.12);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 16px;
          }

          .p-title {
            font-size: 17px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 10px;
          }

          .p-desc {
            font-size: 13.5px;
            color: #64748B;
            line-height: 1.6;
          }

          @media (max-width: 992px) {
            .stats-grid, .pillars-grid {
              grid-template-columns: 1fr 1fr;
            }
            /* story-grid must collapse to one column — two 100px columns is what
               made this section unreadable on phones. */
            .story-grid, .presence-grid {
              grid-template-columns: 1fr;
            }
          }

          @media (max-width: 640px) {
            .pillars-grid, .presence-cities {
              grid-template-columns: 1fr;
            }
            .stats-grid {
              gap: 14px;
            }
            .stat-value {
              font-size: 26px;
            }
            .story-grid {
              gap: 30px;
            }
            .story-img {
              height: 240px;
            }
            .presence-office {
              padding: 20px;
            }
            .founder-card {
              flex-direction: column;
            }
          }
      
        }
      `}</style>
    </div>
  );
};

export default AboutUs;
