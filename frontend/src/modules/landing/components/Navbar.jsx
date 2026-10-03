import React, { useState } from 'react';
import { Menu, X, PhoneCall, Car, ChevronRight } from 'lucide-react';
import { scrollToTop } from '../hooks/useSmoothScroll';
import { useLanding } from '../landingContentContext';

const Navbar = ({ activeTab, setActiveTab, openBookingModal }) => {
  const { brand } = useLanding();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { id: 'home', label: 'Home' },
    { id: 'about', label: 'About Us' },
    { id: 'services', label: 'Services' },
    { id: 'corporate', label: 'Corporate' },
    { id: 'partner', label: 'Partner' },
    { id: 'driver', label: 'Driver' },
    { id: 'advertise', label: 'Advertise' },
    { id: 'contact', label: 'Contact Us' },
  ];

  const handleNavClick = (id) => {
    setActiveTab(id);
    setMobileMenuOpen(false);
    scrollToTop();
  };

  return (
    <header className="navbar-header">
      <div className="container navbar-container">
        {/* Brand Logo */}
        <div 
          className="brand-logo" 
          onClick={() => handleNavClick('home')}
          style={{ cursor: 'pointer' }}
        >
          <img src={brand.logo} alt={`${brand.wordmarkPrimary} ${brand.wordmarkSecondary}`} className="brand-logo-img" />
          <div className="brand-logo-text">
            <div className="logo-text-wrapper">
              <span className="logo-zi">{brand.wordmarkPrimary}</span>
              <span className="logo-cab">{brand.wordmarkSecondary}</span>
            </div>
            <span className="logo-tagline">{brand.tagline}</span>
          </div>
        </div>

        {/* Desktop Navigation Links */}
        <nav className="desktop-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              className={`nav-link-btn ${activeTab === item.id ? 'active' : ''}`}
            >
              {item.label}
              {activeTab === item.id && <span className="active-dot" />}
            </button>
          ))}
        </nav>

        {/* Action Button */}
        <div className="navbar-actions">
          <button 
            className="btn btn-teal nav-book-btn"
            onClick={openBookingModal}
          >
            Book a Ride
          </button>

          {/* Hamburger Menu Toggle for Mobile */}
          <button 
            className="mobile-toggle-btn"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation"
          >
            {mobileMenuOpen ? <X size={26} color="#FFFFFF" /> : <Menu size={26} color="#FFFFFF" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="mobile-drawer animate-fade-in">
          <div className="mobile-drawer-inner">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`mobile-nav-item ${activeTab === item.id ? 'active' : ''}`}
              >
                <span>{item.label}</span>
                <ChevronRight size={18} />
              </button>
            ))}
            <div className="mobile-drawer-cta">
              <button 
                className="btn btn-teal w-full"
                onClick={() => {
                  setMobileMenuOpen(false);
                  openBookingModal();
                }}
              >
                Book a Ride
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .connect-bharat-landing {
          .navbar-header {
            background-color: #0B1F3A;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            position: sticky;
            top: 0;
            z-index: 1000;
            box-shadow: 0 4px 20px rgba(7, 21, 43, 0.5);
          }

          .navbar-container {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: 76px;
          }

          .brand-logo {
            display: flex;
            align-items: center;
            gap: 10px;
          }

          .brand-logo-img {
            width: 46px;
            height: 46px;
            border-radius: 11px;
            object-fit: cover;
            flex-shrink: 0;
          }

          .brand-logo-text {
            display: flex;
            flex-direction: column;
          }

          .logo-text-wrapper {
            display: flex;
            align-items: baseline;
            line-height: 1;
          }

          .logo-zi {
            font-size: 24px;
            font-weight: 800;
            color: #FFFFFF;
            font-style: italic;
            letter-spacing: -0.5px;
          }

          .logo-cab {
            font-size: 22px;
            font-weight: 800;
            color: #00BBA9;
            margin-left: 4px;
            letter-spacing: 1px;
          }

          .logo-tagline {
            font-size: 10.5px;
            color: rgba(255, 255, 255, 0.7);
            font-weight: 400;
            letter-spacing: 0.2px;
            margin-top: 2px;
          }

          .desktop-nav {
            display: flex;
            align-items: center;
            gap: 20px;
          }

          .nav-link-btn {
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.85);
            font-size: 14.5px;
            font-weight: 500;
            cursor: pointer;
            padding: 8px 4px;
            position: relative;
            transition: all 0.2s ease;
          }

          .nav-link-btn:hover {
            color: #00BBA9;
          }

          .nav-link-btn.active {
            color: #FFFFFF;
            font-weight: 600;
          }

          .active-dot {
            position: absolute;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%);
            width: 18px;
            height: 3px;
            background-color: #00BBA9;
            border-radius: 2px;
          }

          .navbar-actions {
            display: flex;
            align-items: center;
            gap: 16px;
          }

          .nav-book-btn {
            padding: 10px 22px;
            font-size: 14.5px;
          }

          .mobile-toggle-btn {
            display: none;
            background: none;
            border: none;
            cursor: pointer;
            padding: 6px;
          }

          .mobile-drawer {
            display: none;
            background-color: #07152B;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            padding: 16px 20px 24px;
          }

          .mobile-drawer-inner {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .mobile-nav-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.06);
            color: #FFFFFF;
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 500;
            cursor: pointer;
            text-align: left;
          }

          .mobile-nav-item.active {
            background: rgba(0, 187, 169, 0.15);
            border-color: #00BBA9;
            color: #00BBA9;
          }

          .mobile-drawer-cta {
            margin-top: 12px;
          }

          .w-full {
            width: 100%;
          }

          @media (max-width: 992px) {
            .desktop-nav {
              display: none;
            }
            .mobile-toggle-btn, .mobile-drawer {
              display: block;
            }
            .nav-book-btn {
              display: none;
            }
          }
      
        }
      `}</style>
    </header>
  );
};

export default Navbar;
