import React, { useState, useRef } from 'react';
import gsap from 'gsap';
import useReveal from '../hooks/useReveal';
import useEntrance from '../hooks/useEntrance';
import useAutoScroll from '../hooks/useAutoScroll';
import useScrollFx from '../hooks/useScrollFx';
import useMagnetic from '../hooks/useMagnetic';
import useTilt from '../hooks/useTilt';
import splitChars from '../hooks/splitChars';
import { onIntro } from '../hooks/introGate';
import {
  MapPin, Users, ArrowRight, ShieldCheck, Navigation,
  Headphones, Wallet, PhoneCall, Car, Plane, Compass,
  Briefcase, Building2, ShoppingBag, Smartphone, QrCode, ChevronRight,
  Star, BadgeCheck, Megaphone, Bike
} from 'lucide-react';
import { useLanding } from '../landingContentContext';
import useAppModules from '../useAppModules';
import useVehicleTypes from '../useVehicleTypes';

const initials = (name) =>
  name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const Home = ({ openBookingModal, setActiveTab }) => {
  const pageRef = useRef(null);
  const driverRail = useRef(null);

  useReveal(pageRef);
  useScrollFx(pageRef);
  useMagnetic(pageRef);
  useTilt(pageRef);
  useAutoScroll(driverRail, { interval: 3800 });

  /**
   * Hero entrance. Deliberately `set` + `to` with clearProps rather than
   * gsap.from: `from` leaves its targets at opacity 0 until the tween plays, so
   * anything that stops the timeline mid-flight strands them invisible — that is
   * what left a hole where the CTA buttons should be. Here the markup is visible
   * by default, the tween owns the hidden state for its own duration only, and
   * clearProps strips every inline style on completion.
   */
  useEntrance(pageRef, () => {
    const shown = { opacity: 1, y: 0, clearProps: 'opacity,transform' };
    const chars = splitChars(pageRef.current.querySelectorAll('.hero-word'));
    const rest = ['.hero-subtitle', '.hero-cta-group > *', '.badge-item', '.booking-card'];
    let watchdog;

    // Build on the intro, not on mount. Setting the hidden state up front would
    // leave the hero blank behind a curtain that never lifted.
    const off = onIntro(() => {
      gsap.set(chars, { yPercent: 115, opacity: 0 });
      rest.forEach((sel) => gsap.set(sel, { opacity: 0, y: 22 }));

      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
        // headline rises character by character out of its line mask
        .to(chars, {
          yPercent: 0,
          opacity: 1,
          duration: 0.8,
          stagger: 0.022,
          clearProps: 'opacity,transform',
        })
        .to('.hero-subtitle', { ...shown, duration: 0.5 }, '-=0.55')
        .to('.hero-cta-group > *', { ...shown, duration: 0.45, stagger: 0.08 }, '-=0.32')
        .to('.badge-item', { ...shown, duration: 0.4, stagger: 0.055 }, '-=0.26')
        .to('.booking-card', { ...shown, duration: 0.7 }, '-=0.7');

      // useEntrance probes the ticker on mount, but this build is deferred until
      // the curtain lifts — by then that probe is long gone. A live ticker always
      // advances a playing timeline within 700ms; if it has not, drop every
      // inline style so the hero is simply visible rather than hidden forever.
      watchdog = setTimeout(() => {
        if (tl.progress() > 0) return;
        tl.kill();
        gsap.set(chars, { clearProps: 'all' });
        rest.forEach((sel) => gsap.set(sel, { clearProps: 'all' }));
      }, 700);
    });

    return () => {
      clearTimeout(watchdog);
      off();
    };
  });

  const [tab, setTab] = useState('city');
  const [pickup, setPickup] = useState('');
  const [drop, setDrop] = useState('');
  const [dateTime, setDateTime] = useState('');
  const [passengers, setPassengers] = useState('1 Passenger');

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    openBookingModal();
  };



  // Photos live in Frontend/public/vehicles/ — see that folder's README + ATTRIBUTION
  // before swapping any of them out.
  // Hero badges store an icon name; components cannot be serialised.
const HERO_BADGE_ICONS = { ShieldCheck, Navigation, Headphones, Wallet };

const fallbackVehicles = [
    {
      name: 'Auto Rickshaw',
      type: 'Auto',
      seats: '3 Seats',
      bags: '1 Bag',
      price: '₹8',
      unit: '/km',
      image: '/vehicles/auto.jpg'
    },
    {
      name: 'Maruti Suzuki Dzire',
      type: 'Sedan',
      seats: '4 Seats',
      bags: '2 Bags',
      price: '₹12',
      unit: '/km',
      image: '/vehicles/dzire.jpg'
    },
    {
      name: 'Maruti Suzuki Ertiga',
      type: 'MUV',
      seats: '6 Seats',
      bags: '4 Bags',
      price: '₹16',
      unit: '/km',
      image: '/vehicles/ertiga.jpg'
    },
    {
      name: 'Toyota Innova Crysta',
      type: 'Premium SUV',
      seats: '6 Seats',
      bags: '4 Bags',
      price: '₹20',
      unit: '/km',
      image: '/vehicles/innova-crysta.jpg'
    },
    {
      name: 'Toyota Fortuner',
      type: 'Luxury SUV',
      seats: '7 Seats',
      bags: '4 Bags',
      price: '₹30',
      unit: '/km',
      image: '/vehicles/fortuner.jpg'
    }
  ];

  // All page content comes from the CMS, falling back to the bundled copy so the
  // page is never blank while the request is in flight or if it fails.
  const { services, valueProps, drivers, partners, launchCities, contact, brand, hero } = useLanding();
  // The app's own module list is the source of truth for what Connect Bharat sells;
  // the CMS list is only a fallback for when it cannot be reached.
  const appModules = useAppModules();
  const serviceCards = appModules.length ? appModules : services;
  const { vehicles } = useVehicleTypes(fallbackVehicles);



  return (
    <div className="home-page animate-fade-in" ref={pageRef}>
      {/* HERO SECTION */}
      <section className="hero-section grain-layer">
        <div className="hero-backdrop-glow" data-parallax="-140" />
        <div className="container hero-container">
          {/* Left Content */}
          <div className="hero-left" data-hero-exit>
            {/* each word gets a clipping mask so it can rise into view */}
            {/* Split per word so each keeps its own clipping mask and rise-in
                animation; the copy itself comes from the CMS. */}
            <h1 className="hero-title">
              {[hero.titleLine1, hero.titleLine2].map((line, lineIndex) => (
                <span className="hero-line" key={lineIndex}>
                  {String(line || '').split(/\s+/).filter(Boolean).map((word, wordIndex, words) => (
                    <span key={wordIndex}>
                      <span className={lineIndex === 1 ? 'hero-word teal-text' : 'hero-word'}>{word}</span>
                      {wordIndex < words.length - 1 ? ' ' : null}
                    </span>
                  ))}
                </span>
              ))}
            </h1>
            <p className="hero-subtitle">{hero.subtitle}</p>

            <div className="hero-cta-group">
              <button className="btn btn-teal hero-btn-main" data-magnetic onClick={openBookingModal}>
                {hero.primaryCta} <ArrowRight size={18} />
              </button>
              <button className="btn btn-outline-light hero-btn-app" onClick={() => setActiveTab('contact')}>
                <Smartphone size={18} /> {hero.secondaryCta}
              </button>
            </div>

            {/* Trust Badges */}
            <div className="hero-trust-badges">
              {(hero.badges || []).map((badge, index) => {
                const BadgeIcon = HERO_BADGE_ICONS[badge.icon] || ShieldCheck;
                return (
                  <div className="badge-item" key={index}>
                    <BadgeIcon size={16} color="#00BBA9" />
                    <span>{badge.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Ride Booking Card */}
          <div className="hero-right">
            <div className="booking-card">
              {/* Tabs */}
              <div className="booking-tabs">
                {[
                  { id: 'city', label: 'City Ride' },
                  { id: 'outstation', label: 'Outstation' },
                  { id: 'airport', label: 'Airport Transfer' },
                ].map((t) => (
                  <button
                    key={t.id}
                    className={`b-tab ${tab === t.id ? 'active' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <form onSubmit={handleSearchSubmit} className="booking-form">
                <div className="field-group">
                  <label>Pickup Location</label>
                  <div className="field-input-wrap">
                    <input 
                      type="text" 
                      placeholder="Enter pickup location" 
                      value={pickup}
                      onChange={(e) => setPickup(e.target.value)}
                    />
                    <MapPin className="field-icon" size={16} color="#00BBA9" />
                  </div>
                </div>

                <div className="field-group">
                  <label>Drop Location</label>
                  <div className="field-input-wrap">
                    <input 
                      type="text" 
                      placeholder="Enter drop location" 
                      value={drop}
                      onChange={(e) => setDrop(e.target.value)}
                    />
                    <MapPin className="field-icon" size={16} color="#00BBA9" />
                  </div>
                </div>

                <div className="field-row">
                  <div className="field-group">
                    <label>Date & Time</label>
                    <div className="field-input-wrap">
                      <input 
                        type="text" 
                        placeholder="Select Date & Time" 
                        value={dateTime}
                        onFocus={(e) => e.target.type = 'datetime-local'}
                        onChange={(e) => setDateTime(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="field-group">
                    <label>Passengers</label>
                    <div className="field-input-wrap">
                      <select value={passengers} onChange={(e) => setPassengers(e.target.value)}>
                        <option value="1 Passenger">1 Passenger</option>
                        <option value="2 Passengers">2 Passengers</option>
                        <option value="4 Passengers">4 Passengers</option>
                        <option value="6 Passengers">6 Passengers</option>
                      </select>
                    </div>
                  </div>
                </div>

                <button type="submit" className="btn btn-teal w-full booking-submit-btn">
                  Find My Ride
                </button>
              </form>
            </div>
          </div>
        </div>
      </section>

      {/* OUR SERVICES SECTION */}
      <section className="section-padding services-section">
        <div className="container">
          <div className="section-title-group" data-reveal>
            <div>
              <span className="eyebrow"><span className="eyebrow-num">01</span> What We Move</span>
              <h2 className="section-title" data-reveal-mask><span>Our Services</span></h2>
            </div>
          </div>

          <div className="services-grid" data-reveal-stagger>
            {serviceCards.map((s) => {
              // Modules carry a real icon image; the CMS fallback carries a
              // lucide component instead.
              const IconComp = typeof s.icon === 'function' ? s.icon : null;
              return (
                <div
                  key={s.id}
                  className="service-card"
                  onClick={() => setActiveTab('services')}
                >
                  <div className="service-icon-wrapper">
                    {s.image ? (
                      <img src={s.image} alt="" className="service-icon-img" loading="lazy" />
                    ) : IconComp ? (
                      <IconComp size={22} color="#0B1F3A" />
                    ) : null}
                  </div>
                  <h3 className="service-card-title">{s.title}</h3>
                  {s.desc && <p className="service-card-desc">{s.desc}</p>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* WHY CHOOSE Connect Bharat? SECTION */}
      <section className="why-us-section grain-layer">
        <div className="container">
          <div className="why-head">
            <span className="eyebrow"><span className="eyebrow-num">02</span> The Difference</span>
            <h2 className="section-title light mb-10" data-reveal-mask><span>Why Choose Connect Bharat?</span></h2>
          </div>

          <div className="why-us-grid" data-reveal-stagger>
            {valueProps.map((v, idx) => {
              const IconComponent = v.icon;
              return (
                <div key={idx} className="why-us-card">
                  <div className="why-icon-box">
                    <IconComponent size={20} color="#00BBA9" />
                  </div>
                  <div className="why-content">
                    <h4 className="why-title">{v.title}</h4>
                    <p className="why-desc">{v.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* POPULAR VEHICLES SECTION */}
      <section className="section-padding vehicles-section">
        <div className="container">
          <div className="section-title-group" data-reveal>
            <div>
              <span className="eyebrow"><span className="eyebrow-num">03</span> The Fleet</span>
              <h2 className="section-title" data-reveal-mask><span>Popular Vehicles</span></h2>
            </div>
          </div>

          {/* Two identical tracks: the first slides left by exactly its own
              width plus one gap, at which point the second sits where the
              first began, so the loop has no visible seam and no end. */}
          <div className="vehicles-marquee">
            {[0, 1].map((pass) => (
            <div className="vehicles-track" key={pass} aria-hidden={pass === 1}>
            {vehicles.map((v, i) => (
              <div key={i} className="vehicle-card" data-tilt>
                <div className="vehicle-img-container" data-img-parallax>
                  <img src={v.image} alt={v.name} className="vehicle-img" loading="lazy" />
                  <span className="vehicle-type-badge">{v.type}</span>
                </div>
                <div className="vehicle-card-body">
                  <h3 className="vehicle-name">{v.name}</h3>
                  <div className="vehicle-specs">
                    {v.seats && <span><Users size={14} /> {v.seats}</span>}
                    {v.bags && <span><Briefcase size={14} /> {v.bags}</span>}
                  </div>

                  <div className="vehicle-price-row">
                    {/* No price row at all when the vehicle has no configured
                        rate — better than showing an empty or invented one. */}
                    <div className="price-tag">
                      {v.price ? (
                        <>
                          <span className="price-num">{v.price}</span>
                          <span className="price-unit">{v.unit}</span>
                        </>
                      ) : null}
                    </div>
                    <button 
                      className="btn btn-outline-teal btn-sm"
                      onClick={openBookingModal}
                    >
                      Book Now
                    </button>
                  </div>
                </div>
              </div>
            ))}
            </div>
            ))}
          </div>
        </div>
      </section>

      {/* MEET OUR DRIVERS SECTION */}
      <section className="section-padding drivers-section grain-layer">
        <div className="container">
          <div className="section-title-group" data-reveal>
            <div>
              <span className="eyebrow"><span className="eyebrow-num">04</span> Who Drives You</span>
              <h2 className="section-title light" data-reveal-mask><span>Meet Our Drivers</span></h2>
              <p className="section-sub">Every Connect Bharat captain is background-verified, police-checked and rated by real riders.</p>
            </div>
            <button className="section-link" onClick={() => setActiveTab('driver')}>
              Become a Driver <ChevronRight size={16} />
            </button>
          </div>

          <div className="drivers-grid snap-row" data-reveal-stagger ref={driverRail}>
            {drivers.map((d, i) => (
              <div key={i} className="driver-card" data-tilt>
                <div className="driver-top">
                  <div className="avatar driver-photo">
                    {initials(d.name)}
                    <img
                      src={d.photo}
                      alt={d.name}
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  </div>
                  <span className={`driver-badge ${d.badge === 'Top Driver' ? 'top' : ''}`}>
                    <BadgeCheck size={12} /> {d.badge}
                  </span>
                </div>

                <h3 className="driver-name">{d.name}</h3>

                <div className="driver-rating">
                  <Star size={14} color="#FBBF24" fill="#FBBF24" />
                  <strong>{d.rating}</strong>
                  <span>· {d.trips}</span>
                </div>

                <div className="driver-meta">
                  <div className="dm-row"><ShieldCheck size={14} color="#00BBA9" /> {d.experience}</div>
                  <div className="dm-row"><Car size={14} color="#00BBA9" /> {d.vehicle}</div>
                  <div className="dm-row"><MapPin size={14} color="#00BBA9" /> {d.city}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* OFFICE & LAUNCH CITIES */}
      <section className="section-padding cities-section">
        <div className="container">
          <div className="section-title-group" data-reveal>
            <div>
              <span className="eyebrow"><span className="eyebrow-num">05</span> Coverage</span>
              <h2 className="section-title" data-reveal-mask><span>Where You&apos;ll Find Us</span></h2>
              <p className="section-sub-dark">{contact.addressShort}</p>
            </div>
            <a className="section-link" href={contact.mapsUrl} target="_blank" rel="noreferrer">
              Get Directions <ChevronRight size={16} />
            </a>
          </div>

          <div className="cities-grid" data-reveal-stagger>
            {launchCities.map((c) => (
              <div key={c.name} className="city-card">
                <div className="city-icon"><MapPin size={20} color="#00BBA9" /></div>
                <h3>{c.name}</h3>
                <span>{c.note}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ADVERTISE TEASER */}
      <section className="advertise-teaser">
        <div className="container advertise-teaser-inner" data-reveal>
          <div>
            <span className="at-tag"><Megaphone size={14} /> For Businesses</span>
            <h2 className="at-title">Advertise with Connect Bharat</h2>
            <p className="at-desc">
              Put your brand in front of thousands of daily riders — across our mobile app, website,
              driver app, home banners, booking screens and push notifications.
            </p>
          </div>
          <button className="btn btn-teal at-btn" onClick={() => setActiveTab('advertise')}>
            Explore Ad Options <ArrowRight size={18} />
          </button>
        </div>
      </section>

      {/* TRUSTED BY & APP DOWNLOAD SECTION */}
      <section className="trusted-app-section">
        <div className="container">
          {/* Trusted Logos */}
          <div className="trusted-block">
            <h3 className="trusted-heading" data-reveal-mask><span>Trusted by Hotels, Airports &amp; Malls</span></h3>
            <div className="partners-marquee" data-marquee-velocity>
              {/* rendered twice so the track loops without a visible seam; the
                  copy is aria-hidden so screen readers do not repeat it */}
              {[0, 1].map((pass) => (
                <div className="partners-track" key={pass} aria-hidden={pass === 1}>
                  {partners.map((p, index) => (
                    <div key={index} className="partner-logo-item">
                      <span className="p-title">{p.name}</span>
                      {p.subtitle && <span className="p-sub">{p.subtitle}</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* App Download Banner */}
          <div className="app-download-banner" data-reveal>
            <div className="app-banner-left">
              <h2 className="app-banner-title">Download Connect Bharat App</h2>
              <p className="app-banner-desc">Book rides on the go, anytime, anywhere.</p>

              <div className="app-store-btns flex gap-4 mt-6">
                {/* Falls back to the placeholder icon until a QR image is uploaded. */}
                <div className="qr-box">
                  {brand.playStoreQr || brand.appStoreQr ? (
                    <img
                      src={brand.playStoreQr || brand.appStoreQr}
                      alt="Scan to download the app"
                      style={{ width: 64, height: 64, objectFit: 'contain' }}
                    />
                  ) : (
                    <QrCode size={40} color="#0B1F3A" />
                  )}
                </div>
                <div className="store-btns-column">
                  {[
                    { url: brand.playStoreUrl, sub: 'GET IT ON', name: 'Google Play' },
                    { url: brand.appStoreUrl, sub: 'Download on the', name: 'App Store' },
                  ].map((badge) => {
                    const Tag = badge.url ? 'a' : 'div';
                    const props = badge.url ? { href: badge.url, target: '_blank', rel: 'noreferrer' } : {};
                    return (
                      <Tag key={badge.name} className="store-btn" {...props}>
                        <span className="st-sub">{badge.sub}</span>
                        <span className="st-name">{badge.name}</span>
                      </Tag>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="app-banner-right">
              <div className="mockup-phone" data-parallax="-70">
                <div className="mockup-screen">
                  <div className="m-header">
                    <span className="m-logo">Connect Bharat</span>
                  </div>
                  <div className="m-body">
                    <p className="m-tag">Your Ride. Our Priority.</p>
                    <div className="m-btn">Book a Ride</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <style>{`
        .connect-bharat-landing {
          /* HERO STYLES */
          .hero-section {
            background: #07152B url('/carbackground.png') no-repeat 88% center;
            background-size: cover;
            position: relative;
            padding: 60px 0 80px;
            overflow: hidden;
            color: #FFFFFF;
          }

          .hero-backdrop-glow {
            position: absolute;
            top: -20%;
            left: 30%;
            width: min(500px, 70vw);
            height: min(500px, 70vw);
            background: radial-gradient(circle, rgba(0, 187, 169, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
            pointer-events: none;
            z-index: 1;
          }

          .hero-container {
            display: grid;
            grid-template-columns: 1.25fr 0.75fr;
            gap: 20px;
            align-items: center;
            position: relative;
            z-index: 2;
          }

          .hero-title {
            font-size: 52px;
            font-weight: 800;
            line-height: 1.1;
            margin-bottom: 18px;
            letter-spacing: -1px;
          }

          /* Clipping mask per line: the words sit inside it and translate up from
             below, so they appear to rise out of the line rather than just fade. */
          .hero-line {
            display: block;
            overflow: hidden;
            padding-bottom: 0.06em;
          }

          .hero-word {
            display: inline-block;
            will-change: transform;
          }

          .teal-text {
            color: #00BBA9;
          }

          .hero-subtitle {
            font-size: 16.5px;
            color: #CBD5E1;
            line-height: 1.6;
            max-width: 500px;
            margin-bottom: 30px;
          }

          .hero-cta-group {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            margin-bottom: 40px;
          }

          .hero-btn-main {
            padding: 15px 32px;
            font-size: 16px;
          }

          .hero-btn-app {
            padding: 15px 26px;
            font-size: 15px;
          }

          .hero-trust-badges {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            padding-top: 24px;
          }

          .badge-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13.5px;
            color: #E2E8F0;
            font-weight: 500;
          }

          .hero-right {
            display: flex;
            justify-content: flex-end;
          }

          /* BOOKING CARD */
          /* Frosted glass over the hero photo rather than an opaque navy block --
             the backdrop blur is what makes it read as a floating panel. */
          .booking-card {
            background: linear-gradient(165deg, rgba(18, 38, 66, 0.82), rgba(8, 20, 38, 0.9));
            backdrop-filter: blur(18px) saturate(140%);
            -webkit-backdrop-filter: blur(18px) saturate(140%);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: var(--radius-lg);
            padding: 20px 22px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5), var(--hairline-dark),
              0 0 0 1px rgba(0, 187, 169, 0.12);
            max-width: 420px;
            width: 100%;
          }

          .booking-tabs {
            display: flex;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 3px;
            gap: 3px;
            margin-bottom: 14px;
          }

          .b-tab {
            flex: 1;
            background: none;
            border: none;
            color: #94A3B8;
            padding: 7px 4px;
            font-size: 12.5px;
            font-weight: 500;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .b-tab.active {
            background-color: #00BBA9;
            color: #FFFFFF;
            font-weight: 600;
          }

          .booking-form {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .field-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .field-group label {
            font-size: 11.5px;
            color: #94A3B8;
            font-weight: 500;
          }

          .field-input-wrap {
            position: relative;
            display: flex;
            align-items: center;
          }

          .field-input-wrap input, .field-input-wrap select {
            width: 100%;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 7px;
            padding: 9px 12px;
            color: #FFFFFF;
            font-size: 13px;
            outline: none;
          }

          .field-input-wrap input:focus, .field-input-wrap select:focus {
            border-color: #00BBA9;
          }

          .field-icon {
            position: absolute;
            right: 12px;
            pointer-events: none;
          }

          .field-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }

          .booking-submit-btn {
            margin-top: 6px;
            padding: 13px;
            font-size: 14.5px;
          }

          /* SERVICES GRID */
          .services-section {
            background: var(--bg-white);
          }

          .services-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 12px;
          }

          .service-icon-img {
            width: 26px;
            height: 26px;
            object-fit: contain;
          }

          .service-card-desc {
            margin-top: 4px;
            font-size: 12px;
            line-height: 1.4;
            color: #64748B;
            text-align: center;
          }

          .service-card {
            background: var(--bg-raised);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-md);
            box-shadow: var(--shadow-sm), var(--hairline);
            padding: 18px 8px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            cursor: pointer;
            transition: var(--transition);
          }

          .service-card:hover {
            border-color: rgba(0, 187, 169, 0.5);
            transform: translateY(-4px);
            box-shadow: var(--shadow-md), 0 10px 26px rgba(0, 187, 169, 0.16), var(--hairline);
          }

          .service-card:hover .service-icon-wrapper {
            background: linear-gradient(160deg, #14CDBA, #009C8D);
            transform: scale(1.06);
          }

          .service-card:hover .service-icon-wrapper svg {
            stroke: #FFFFFF;
          }

          .service-icon-wrapper {
            width: 46px;
            height: 46px;
            background: linear-gradient(160deg, #E9FAF8, #D3F2EE);
            box-shadow: inset 0 0 0 1px rgba(0, 187, 169, 0.16);
            transition: var(--transition);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 10px;
          }

          .service-card-title {
            font-size: 13px;
            font-weight: 600;
            color: #0F172A;
            line-height: 1.25;
          }

          /* WHY US SECTION */
          .why-us-section {
            color: #FFFFFF;
            padding: clamp(44px, 5vw, 68px) 0 clamp(52px, 6vw, 74px);
            background-color: var(--navy-deep);
            background-image:
              radial-gradient(70% 120% at 0% 0%, rgba(0, 187, 169, 0.18), transparent 55%),
              radial-gradient(60% 100% at 100% 100%, rgba(43, 92, 168, 0.22), transparent 55%),
              linear-gradient(150deg, #0A1D36, #071228);
          }

          .mb-10 {
            margin-bottom: 30px;
          }

          .why-us-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 20px;
          }

          .why-us-card {
            display: flex;
            flex-direction: row;
            align-items: flex-start;
            gap: 12px;
          }

          .why-icon-box {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: rgba(0, 187, 169, 0.12);
            border: 1px solid rgba(0, 187, 169, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .why-title {
            font-size: 14px;
            font-weight: 700;
            color: #FFFFFF;
            line-height: 1.3;
            margin-bottom: 4px;
          }

          .why-desc {
            font-size: 12px;
            color: #94A3B8;
            line-height: 1.45;
          }

          /* VEHICLES GRID */
          .vehicles-section {
            background:
              radial-gradient(80% 60% at 100% 0%, rgba(0, 187, 169, 0.07), transparent 60%),
              var(--bg-light);
          }

          /* Continuous, endless marquee — same approach as the partner strip.
             The catalog outgrew a single screen (eighteen vehicles five-across
             stacked into four rows), and a scroll-snap rail only stepped a card
             at a time and stopped at the end. */
          .vehicles-marquee {
            display: flex;
            --marquee-gap: 20px;
            gap: var(--marquee-gap);
            overflow: hidden;
            mask-image: linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent);
            -webkit-mask-image: linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent);
          }

          .vehicles-track {
            display: flex;
            gap: var(--marquee-gap);
            flex-shrink: 0;
            animation: zc-marqueeScroll 42s linear infinite;
          }

          .vehicles-marquee:hover .vehicles-track {
            animation-play-state: paused;
          }

          .vehicles-track > .vehicle-card {
            flex: 0 0 246px;
          }

          @media (prefers-reduced-motion: reduce) {
            .vehicles-track {
              animation: none;
            }
            .vehicles-marquee {
              overflow-x: auto;
            }
          }

          /* On a touch screen a moving row is the wrong trade: you cannot swipe
             an overflow:hidden marquee, and Book Now becomes a target that
             slides out from under your thumb. Touch devices get a swipeable
             snap rail instead, and the duplicate track is dropped since there is
             nothing to loop. Pointer devices keep the continuous marquee. */
          @media (hover: none), (max-width: 768px) {
            .vehicles-marquee {
              overflow-x: auto;
              scroll-snap-type: x mandatory;
              -webkit-overflow-scrolling: touch;
              scrollbar-width: none;
              mask-image: none;
              -webkit-mask-image: none;
              /* bleed to the gutter so the next card peeks in and the row reads
                 as swipeable without a hint label */
              margin: 0 -16px;
              padding: 2px 16px 12px;
            }

            .vehicles-marquee::-webkit-scrollbar {
              display: none;
            }

            .vehicles-track {
              animation: none;
            }

            .vehicles-track[aria-hidden='true'] {
              display: none;
            }

            .vehicles-track > .vehicle-card {
              scroll-snap-align: start;
              flex-basis: 72vw;
              max-width: 260px;
            }
          }

          .vehicle-card {
            background: var(--bg-raised);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-lg);
            overflow: hidden;
            transition: transform 0.35s var(--ease-out), box-shadow 0.35s var(--ease-out),
              border-color 0.35s ease;
            box-shadow: var(--shadow-sm), var(--hairline);
          }

          .vehicle-card:hover {
            transform: translateY(-6px);
            box-shadow: var(--shadow-lg), var(--hairline);
            border-color: rgba(0, 187, 169, 0.45);
          }

          .vehicle-img-container {
            height: 150px;
            background: #FFFFFF;
            overflow: hidden;
          }

          .vehicle-img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }

          .vehicle-card-body {
            padding: 18px;
          }

          .vehicle-name {
            font-size: 18px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 8px;
          }

          .vehicle-specs {
            display: flex;
            gap: 16px;
            font-size: 12.5px;
            color: #64748B;
            margin-bottom: 16px;
          }

          .vehicle-specs span {
            display: flex;
            align-items: center;
            gap: 4px;
          }

          .vehicle-price-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-top: 1px solid #F1F5F9;
            padding-top: 14px;
          }

          .price-num {
            font-size: 20px;
            font-weight: 800;
            color: #0F172A;
          }

          .price-unit {
            font-size: 12px;
            color: #64748B;
          }

          .btn-outline-teal {
            background: linear-gradient(180deg, #EEFBF9, #DFF6F3);
            color: var(--teal-ink);
            border: 1px solid rgba(0, 187, 169, 0.45);
            box-shadow: var(--hairline);
            border-radius: var(--radius-full);
            font-size: 13px;
            font-weight: 600;
            padding: 6px 14px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .btn-outline-teal:hover {
            background: #00BBA9;
            color: #FFFFFF;
          }

          .vehicle-img-container {
            position: relative;
          }

          .vehicle-type-badge {
            position: absolute;
            top: 12px;
            left: 12px;
            background: rgba(7, 21, 43, 0.85);
            color: #00BBA9;
            font-size: 11px;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 20px;
            border: 1px solid rgba(0, 187, 169, 0.4);
          }

          /* DRIVER PROFILES */
          .drivers-section {
            background-color: var(--navy-deep);
            background-image:
              radial-gradient(60% 90% at 85% 0%, rgba(0, 187, 169, 0.16), transparent 58%),
              linear-gradient(150deg, #071528 0%, #0B1F3A 100%);
          }

          .section-sub {
            font-size: 14px;
            color: #94A3B8;
            margin-top: 6px;
            max-width: 560px;
          }

          .section-sub-dark {
            font-size: 14px;
            color: #64748B;
            margin-top: 6px;
          }

          .drivers-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 22px;
          }

          .driver-card {
            background: linear-gradient(165deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.03));
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.11);
            border-radius: var(--radius-lg);
            padding: 22px;
            color: #FFFFFF;
            box-shadow: var(--hairline-dark);
            transition: transform 0.35s var(--ease-out), box-shadow 0.35s var(--ease-out),
              border-color 0.35s ease;
          }

          .driver-card:hover {
            border-color: #00BBA9;
            transform: translateY(-5px);
            box-shadow: 0 16px 32px rgba(0, 0, 0, 0.35);
          }

          .driver-top {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            margin-bottom: 14px;
          }

          .driver-photo {
            width: 68px;
            height: 68px;
            border-radius: 50%;
            border: 2px solid #00BBA9;
            font-size: 22px;
          }

          .driver-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 10.5px;
            font-weight: 700;
            padding: 4px 9px;
            border-radius: 20px;
            background: rgba(255, 255, 255, 0.1);
            color: #CBD5E1;
            border: 1px solid rgba(255, 255, 255, 0.18);
          }

          .driver-badge.top {
            background: rgba(0, 187, 169, 0.15);
            color: #00BBA9;
            border-color: rgba(0, 187, 169, 0.45);
          }

          .driver-name {
            font-size: 16.5px;
            font-weight: 700;
            margin-bottom: 5px;
          }

          .driver-rating {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 13px;
            color: #94A3B8;
            margin-bottom: 14px;
          }

          .driver-rating strong {
            color: #FFFFFF;
          }

          .driver-meta {
            display: flex;
            flex-direction: column;
            gap: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            padding-top: 14px;
          }

          .dm-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: #CBD5E1;
            line-height: 1.4;
          }

          /* LAUNCH CITIES */
          .cities-section {
            background: var(--bg-white);
          }

          .cities-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 22px;
          }

          .city-card {
            background: var(--bg-raised);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-lg);
            padding: 26px 22px;
            box-shadow: var(--shadow-sm), var(--hairline);
            transition: var(--transition);
          }

          .city-card:hover {
            border-color: rgba(0, 187, 169, 0.45);
            transform: translateY(-4px);
            box-shadow: var(--shadow-md), 0 12px 28px rgba(0, 187, 169, 0.14), var(--hairline);
          }

          .city-icon {
            width: 44px;
            height: 44px;
            background: #E6F8F6;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 14px;
          }

          .city-card h3 {
            font-size: 19px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 4px;
          }

          .city-card span {
            font-size: 13px;
            color: #64748B;
          }

          /* ADVERTISE TEASER */
          .advertise-teaser {
            background: #0B1F3A;
            padding: 44px 0;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
          }

          .advertise-teaser-inner {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 30px;
            color: #FFFFFF;
          }

          .at-tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 11.5px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #00BBA9;
            background: rgba(0, 187, 169, 0.12);
            padding: 4px 12px;
            border-radius: 20px;
            margin-bottom: 10px;
          }

          .at-title {
            font-size: 28px;
            font-weight: 800;
            margin-bottom: 6px;
          }

          .at-desc {
            font-size: 14.5px;
            color: #94A3B8;
            line-height: 1.6;
            max-width: 640px;
          }

          .at-btn {
            flex-shrink: 0;
            padding: 14px 28px;
            border-radius: 30px;
          }

          /* TRUSTED & APP SECTION */
          .trusted-app-section {
            padding: clamp(44px, 5vw, 66px) 0;
            background: var(--bg-light);
          }

          .trusted-block {
            margin-bottom: 50px;
          }

          .trusted-heading {
            font-size: 20px;
            font-weight: 700;
            color: #0F172A;
            margin-bottom: 24px;
          }

          /* Continuous logo marquee. Two identical tracks slide left by exactly one
             track width, so the second lands where the first started — seamless. */
          .partners-marquee {
            display: flex;
            /* the keyframe shifts by one track width plus this gap, so the two
               must always agree — keep them tied through the variable */
            --marquee-gap: 20px;
            gap: var(--marquee-gap);
            overflow: hidden;
            mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
            -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
          }

          .partners-track {
            display: flex;
            gap: var(--marquee-gap);
            flex-shrink: 0;
            animation: zc-marqueeScroll 32s linear infinite;
          }

          .partners-marquee:hover .partners-track {
            animation-play-state: paused;
          }

          /* decorative only: never intercept a swipe */
          .partners-marquee {
            pointer-events: none;
          }

          

          @media (prefers-reduced-motion: reduce) {
            .partners-track {
              animation: none;
            }
          }

          .partner-logo-item {
            background: var(--bg-raised);
            border: 1px solid var(--border-light);
            box-shadow: var(--shadow-sm), var(--hairline);
            padding: 14px 20px;
            border-radius: var(--radius-md);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-width: 150px;
            flex-shrink: 0;
          }

          .partner-logo-item .p-title {
            font-size: 15px;
            font-weight: 800;
            color: #0B1F3A;
            letter-spacing: 0.5px;
          }

          .partner-logo-item .p-sub {
            font-size: 8.5px;
            color: #64748B;
            letter-spacing: 0.8px;
          }

          .app-download-banner {
            background: linear-gradient(135deg, #00BBA9 0%, #009688 100%);
            border-radius: 20px;
            padding: 40px 50px;
            display: grid;
            grid-template-columns: 1.2fr 0.8fr;
            align-items: center;
            color: #FFFFFF;
            box-shadow: 0 16px 36px rgba(0, 187, 169, 0.25);
          }

          .app-banner-title {
            font-size: 32px;
            font-weight: 800;
            margin-bottom: 8px;
          }

          .app-banner-desc {
            font-size: 16px;
            opacity: 0.95;
          }

          .qr-box {
            background: #FFFFFF;
            padding: 10px;
            border-radius: 12px;
          }

          .store-btns-column {
            display: flex;
            gap: 10px;
          }

          .store-btn {
            background: #0B1F3A;
            padding: 8px 16px;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            cursor: pointer;
          }

          .st-sub {
            font-size: 9px;
            opacity: 0.7;
          }

          .st-name {
            font-size: 13px;
            font-weight: 600;
          }

          .mockup-phone {
            width: 220px;
            height: 320px;
            background: #0B1F3A;
            border: 6px solid #FFFFFF;
            border-radius: 30px;
            margin: 0 auto;
            padding: 10px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.3);
          }

          .mockup-screen {
            background: #07152B;
            height: 100%;
            border-radius: 20px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            text-align: center;
          }

          .m-logo {
            font-weight: 800;
            font-size: 20px;
            color: #00BBA9;
          }

          .m-tag {
            font-size: 11px;
            color: #FFFFFF;
            margin: 10px 0;
          }

          .m-btn {
            background: #00BBA9;
            color: #FFFFFF;
            font-size: 12px;
            font-weight: 600;
            padding: 8px 16px;
            border-radius: 20px;
          }

          /* RESPONSIVE MEDIA QUERIES */
          @media (max-width: 1200px) {
            .vehicles-track > .vehicle-card {
              flex-basis: 210px;
            }
          }

          @media (max-width: 1024px) {
            .hero-container {
              grid-template-columns: 1fr;
            }
            .hero-right {
              justify-content: flex-start;
            }
            .services-grid {
              grid-template-columns: repeat(4, 1fr);
            }
            .why-us-grid, .drivers-grid {
              grid-template-columns: repeat(2, 1fr);
            }
            .advertise-teaser-inner {
              flex-direction: column;
              align-items: flex-start;
            }
            .app-download-banner {
              grid-template-columns: 1fr;
              gap: 30px;
              padding: 30px;
            }
          }

          @media (max-width: 768px) {
            .hero-section {
              padding: 38px 0 48px;
              background-position: 70% center;
            }
            .hero-title {
              font-size: 40px;
            }
            /* tighten the stack: subtitle -> buttons -> badges was leaving a big
               dead band in the middle of the hero on a phone */
            .hero-subtitle {
              font-size: 15.5px;
              margin-bottom: 18px;
            }
            .hero-cta-group {
              gap: 10px;
              margin-bottom: 18px;
            }
            .hero-trust-badges {
              gap: 12px 14px;
              padding-top: 16px;
            }
            .hero-container {
              gap: 24px;
            }
            .booking-card {
              max-width: 100%;
            }
            .at-title {
              font-size: 23px;
            }
            .app-banner-title {
              font-size: 25px;
            }
            .trusted-app-section {
              padding: 45px 0;
            }
            .trusted-block {
              margin-bottom: 34px;
            }
          }

          @media (max-width: 640px) {
            .hero-title {
              font-size: 33px;
            }
            .services-grid {
              grid-template-columns: repeat(2, 1fr);
            }
            .why-us-grid, .drivers-grid, .cities-grid {
              grid-template-columns: 1fr;
            }
            .partners-marquee, .vehicles-marquee {
              --marquee-gap: 12px;
            }
            
            .partner-logo-item {
              min-width: 132px;
              padding: 12px 14px;
            }
            .app-download-banner {
              padding: 24px 20px;
              border-radius: 16px;
            }
            .app-store-btns {
              flex-wrap: wrap;
            }
            .hero-btn-main, .hero-btn-app {
              flex: 1 1 auto;
              justify-content: center;
            }
            .field-row {
              grid-template-columns: 1fr;
            }
            .booking-tabs {
              gap: 2px;
            }
            .b-tab {
              font-size: 11.5px;
              padding: 8px 2px;
            }

            /* --- length trimming: same content, far less scrolling --- */

            /* 9 icon tiles: 3 across = 3 rows instead of 5 */
            .services-grid {
              grid-template-columns: repeat(3, 1fr);
              gap: 8px;
            }
            .service-card {
              padding: 12px 4px;
            }
            .service-icon-wrapper {
              width: 38px;
              height: 38px;
              margin-bottom: 7px;
            }
            .service-card-title {
              font-size: 11px;
            }

            /* value props as compact rows rather than tall cards */
            .why-us-section {
              padding: 34px 0 38px;
            }
            .why-us-grid {
              gap: 18px;
            }
            /* the icon shrinks on mobile, so the row gap has to grow to stop the
               heading sitting right against it */
            .why-us-card {
              gap: 14px;
            }
            .why-icon-box {
              width: 34px;
              height: 34px;
            }
            .why-title {
              font-size: 13.5px;
            }
            .why-desc {
              font-size: 11.5px;
            }
            .mb-10 {
              margin-bottom: 20px;
            }

            /* launch cities: icon on the left, name + note stacked beside it,
               so each city is one short row instead of a tall stacked card */
            .city-card {
              display: grid;
              grid-template-columns: auto 1fr;
              column-gap: 12px;
              align-items: center;
              padding: 14px 16px;
            }
            .city-icon {
              grid-row: 1 / span 2;
              width: 36px;
              height: 36px;
              margin-bottom: 0;
            }
            .city-card h3 {
              font-size: 16px;
              margin-bottom: 0;
            }
            .city-card span {
              font-size: 11.5px;
            }

            .advertise-teaser {
              padding: 30px 0;
            }
            .at-desc {
              font-size: 13.5px;
            }
          }
      
        }

        /* One track width plus the gap, so track two lands exactly where
           track one started. */
        /* One track width plus one gap, so the duplicate track lands exactly
           where the first began. There were previously two blocks with the same
           name and different offsets, and the partner strip referenced a third
           name that did not exist — so it never moved at all. */
        @keyframes zc-marqueeScroll {
        to { transform: translateX(calc(-100% - var(--marquee-gap))); }
        }
      `}</style>
    </div>
  );
};

export default Home;
