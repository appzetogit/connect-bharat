import { useLanding } from '../landingContentContext';
import { LANDING_ICONS } from '../useLandingContent';
import useAppModules from '../useAppModules';
import React, { useRef } from 'react';
import {
  Car, Plane, Compass, Briefcase, Building2, ShoppingBag,
  CheckCircle, ArrowRight, Bike
} from 'lucide-react';
import useReveal from '../hooks/useReveal';

const Services = ({ openBookingModal }) => {
  const pageRef = useRef(null);
  useReveal(pageRef);


  const { servicesPage } = useLanding();
  const appModules = useAppModules();

  // The module list decides which services exist — it is what the app actually
  // sells. The CMS entries then supply the richer presentation (photo, badge,
  // feature bullets) for whichever ones have been written up, matched on name.
  // A module with no CMS entry still renders, using its own icon and blurb.
  const normalise = (value) =>
    String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^zi/, '');

  const cmsItems = servicesPage.items || [];
  // Prefix matching, not equality: the module is "Zi City Ride" while the
  // write-up is titled "City Ride (Local Cabs)", and neither name is going to be
  // edited to suit the other.
  const findCmsMatch = (title) => {
    const key = normalise(title);
    if (!key) return undefined;
    const related = (a, b) => a && b && (a.startsWith(b) || b.startsWith(a));
    return (
      cmsItems.find((item) => normalise(item.title) === key || normalise(item.id) === key) ||
      cmsItems.find((item) => related(normalise(item.title), key) || related(normalise(item.id), key))
    );
  };

  const allServices = appModules.length
    ? appModules.map((module) => {
        const match = findCmsMatch(module.title) || {};
        return {
          ...match,
          id: module.id,
          title: module.title,
          description: match.description || module.desc,
          tag: match.tag || module.desc,
          image: match.image || module.image,
          features: match.features || [],
          icon: LANDING_ICONS[match.icon] || Car,
        };
      })
    : cmsItems.map((item) => ({ ...item, icon: LANDING_ICONS[item.icon] || Car }));


  return (
    <div className="services-page animate-fade-in" ref={pageRef}>
      <div className="page-hero">
        <div className="container">
          <span className="page-tag">{servicesPage.tag}</span>
          <h1 className="page-title">{servicesPage.title}</h1>
          <p className="page-subtitle">{servicesPage.subtitle}</p>
        </div>
      </div>

      <section className="section-padding">
        <div className="container">
          <div className="services-list-grid" data-reveal-stagger>
            {allServices.map((s) => {
              const IconComp = s.icon;
              return (
                <div key={s.id} className="service-detail-card">
                  <div className="s-card-img-box">
                    <img src={s.image} alt={s.title} className="s-card-img" />
                    <span className="s-badge">{s.tag}</span>
                  </div>

                  <div className="s-card-content">
                    <div className="s-title-row">
                      <div className="s-icon-bg">
                        <IconComp size={22} color="#00BBA9" />
                      </div>
                      <h3 className="s-title">{s.title}</h3>
                    </div>

                    <p className="s-desc">{s.description}</p>

                    {/* omitted entirely for a module with no write-up yet,
                        rather than leaving an empty gap under the description */}
                    {s.features?.length > 0 && (
                      <div className="s-features-list">
                        {s.features.map((feat, i) => (
                          <div key={i} className="sf-item">
                            <CheckCircle size={15} color="#00BBA9" />
                            <span>{feat}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <button className="btn btn-teal w-full mt-4" onClick={openBookingModal}>
                      {servicesPage.ctaLabel} <ArrowRight size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          .services-list-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 30px;
          }

          .service-detail-card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: var(--shadow-sm);
            transition: var(--transition);
            display: flex;
            flex-direction: column;
          }

          .service-detail-card:hover {
            transform: translateY(-5px);
            box-shadow: var(--shadow-lg);
            border-color: #00BBA9;
          }

          .s-card-img-box {
            position: relative;
            height: 200px;
            overflow: hidden;
          }

          .s-card-img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }

          .s-badge {
            position: absolute;
            top: 14px;
            right: 14px;
            background: rgba(7, 21, 43, 0.85);
            backdrop-filter: blur(6px);
            color: #00BBA9;
            font-size: 11.5px;
            font-weight: 600;
            padding: 4px 12px;
            border-radius: 20px;
            border: 1px solid rgba(0, 187, 169, 0.4);
          }

          .s-card-content {
            padding: 24px;
            display: flex;
            flex-direction: column;
            flex: 1;
          }

          .s-title-row {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
          }

          .s-icon-bg {
            width: 40px;
            height: 40px;
            background: rgba(0, 187, 169, 0.1);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .s-title {
            font-size: 19px;
            font-weight: 700;
            color: #0F172A;
          }

          .s-desc {
            font-size: 14px;
            color: #64748B;
            line-height: 1.6;
            margin-bottom: 16px;
          }

          .s-features-list {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 16px;
            background: #F8FAFC;
            padding: 12px;
            border-radius: 10px;
          }

          .sf-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12.5px;
            color: #334155;
            font-weight: 500;
          }

          .mt-4 {
            margin-top: auto;
          }

          @media (max-width: 992px) {
            .services-list-grid {
              grid-template-columns: 1fr;
            }
          }

          /* Nine full-bleed cards is a very long phone page — shrink the hero
             image and keep the feature list two-up so each card stays compact. */
          @media (max-width: 640px) {
            .services-list-grid {
              gap: 18px;
            }
            .s-card-img-box {
              height: 140px;
            }
            .s-card-content {
              padding: 18px 16px;
            }
            .s-title {
              font-size: 17px;
            }
            .s-desc {
              font-size: 13px;
              margin-bottom: 12px;
            }
            .s-features-list {
              gap: 7px;
              padding: 10px;
              margin-bottom: 14px;
            }
            .sf-item {
              font-size: 11.5px;
            }
          }
      
        }
      `}</style>
    </div>
  );
};

export default Services;
