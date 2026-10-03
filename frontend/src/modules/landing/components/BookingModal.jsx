import React, { useState } from 'react';
import { X, MapPin, Calendar, User, CheckCircle2, Car, Shield, ArrowRight } from 'lucide-react';
import api from '../../../shared/api/axiosInstance';
import { useLanding } from '../landingContentContext';

const BookingModal = ({ isOpen, onClose, selectedVehicle = null }) => {
  const { contact: CONTACT } = useLanding();
  const [step, setStep] = useState(1);
  const [tripType, setTripType] = useState('city');
  const [pickup, setPickup] = useState('Gandhinagar, Bengaluru');
  const [drop, setDrop] = useState('Kempegowda Int. Airport (BLR)');
  const [vehicle, setVehicle] = useState(selectedVehicle || 'Dzire');
  const [date, setDate] = useState('2026-08-06');
  const [passengers, setPassengers] = useState('2');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [requestId, setRequestId] = useState('');

  if (!isOpen) return null;

  const vehicleOptions = [
    { id: 'Auto', name: 'Auto Rickshaw', rate: '₹8/km', capacity: '3 Seats', eta: '3 mins' },
    { id: 'Dzire', name: 'Maruti Suzuki Dzire (Sedan)', rate: '₹12/km', capacity: '4 Seats', eta: '4 mins' },
    { id: 'Ertiga', name: 'Maruti Suzuki Ertiga (MUV)', rate: '₹16/km', capacity: '6 Seats', eta: '6 mins' },
    { id: 'Innova Crysta', name: 'Toyota Innova Crysta (Premium SUV)', rate: '₹20/km', capacity: '6 Seats', eta: '8 mins' },
    { id: 'Toyota Fortuner', name: 'Toyota Fortuner (Luxury SUV)', rate: '₹30/km', capacity: '7 Seats', eta: '12 mins' },
  ];

  const tripTypes = [
    { id: 'auto', label: 'Auto' },
    { id: 'city', label: 'City Ride' },
    { id: 'outstation', label: 'Outstation' },
    { id: 'airport', label: 'Airport Transfer' },
  ];

  const handleConfirmBooking = async (e) => {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const res = await api.post('/users/booking-request', {
        name,
        phone,
        pickup,
        drop,
        vehicleType: vehicle,
        scheduledAt: date || null,
      });
      // the reference the admin sees in Trip Requests, so support can match a call to a row
      setRequestId(res?.data?.data?.requestId || '');
      setStep(3);
    } catch (err) {
      setSubmitError(
        err?.response?.data?.message ||
          'Could not send your request. Please check your details and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setStep(1);
    onClose();
  };

  return (
    <div className="modal-overlay animate-fade-in">
      <div className="modal-card">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <span className="modal-badge">Connect Bharat Dispatch</span>
            <h3 className="modal-title">
              {step === 1 && 'Plan Your Ride'}
              {step === 2 && 'Passenger Details'}
              {step === 3 && 'Booking Confirmed!'}
            </h3>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            <X size={20} color="#94A3B8" />
          </button>
        </div>

        {/* Step 1: Ride Configuration */}
        {step === 1 && (
          <div className="modal-body">
            {/* Trip Type Tabs */}
            <div className="tab-pills">
              {tripTypes.map((t) => (
                <button
                  key={t.id}
                  className={`tab-pill ${tripType === t.id ? 'active' : ''}`}
                  onClick={() => setTripType(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="input-group">
              <label><MapPin size={16} color="#00BBA9" /> Pickup Location</label>
              <input 
                type="text" 
                value={pickup} 
                onChange={(e) => setPickup(e.target.value)} 
                placeholder="Enter pickup address or landmark"
              />
            </div>

            <div className="input-group">
              <label><MapPin size={16} color="#00BBA9" /> Drop Location</label>
              <input 
                type="text" 
                value={drop} 
                onChange={(e) => setDrop(e.target.value)} 
                placeholder="Enter drop location"
              />
            </div>

            <div className="input-row">
              <div className="input-group">
                <label><Calendar size={16} color="#00BBA9" /> Date & Time</label>
                <input 
                  type="date" 
                  value={date} 
                  onChange={(e) => setDate(e.target.value)} 
                />
              </div>

              <div className="input-group">
                <label><User size={16} color="#00BBA9" /> Passengers</label>
                <select value={passengers} onChange={(e) => setPassengers(e.target.value)}>
                  <option value="1">1 Passenger</option>
                  <option value="2">2 Passengers</option>
                  <option value="4">4 Passengers</option>
                  <option value="6">6 Passengers</option>
                </select>
              </div>
            </div>

            <div className="vehicle-selector">
              <label className="section-sublabel"><Car size={16} color="#00BBA9" /> Select Preferred Vehicle</label>
              <div className="vehicle-grid">
                {vehicleOptions.map((v) => (
                  <div 
                    key={v.id}
                    className={`vehicle-card-item ${vehicle === v.id ? 'selected' : ''}`}
                    onClick={() => setVehicle(v.id)}
                  >
                    <div className="v-item-header">
                      <span className="v-name">{v.name}</span>
                      <span className="v-rate">{v.rate}</span>
                    </div>
                    <div className="v-item-sub">
                      <span>{v.capacity}</span>
                      <span>ETA {v.eta}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-footer">
              <button 
                className="btn btn-teal w-full"
                onClick={() => setStep(2)}
              >
                Proceed to Passenger Info <ArrowRight size={18} />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Passenger Details */}
        {step === 2 && (
          <form onSubmit={handleConfirmBooking} className="modal-body">
            <div className="trip-summary-box">
              <div className="sum-item">
                <span className="sum-label">Trip:</span>
                <span className="sum-val">{pickup} → {drop}</span>
              </div>
              <div className="sum-item">
                <span className="sum-label">Selected Car:</span>
                <span className="sum-val highlight">{vehicle}</span>
              </div>
              <div className="sum-item">
                <span className="sum-label">Est. Fare:</span>
                <span className="sum-val fare">₹780 (Fixed rate, no surge)</span>
              </div>
            </div>

            <div className="input-group">
              <label>Full Name</label>
              <input 
                type="text" 
                required 
                value={name} 
                onChange={(e) => setName(e.target.value)} 
                placeholder="Enter your name"
              />
            </div>

            <div className="input-group">
              <label>Phone Number (for Driver WhatsApp / SMS)</label>
              <input 
                type="tel" 
                required 
                value={phone} 
                onChange={(e) => setPhone(e.target.value)} 
                placeholder="+91 98765 43210"
              />
            </div>

            {submitError && (
              <div className="booking-error" role="alert">
                {submitError}
              </div>
            )}

            <div className="security-notice">
              <Shield size={16} color="#00BBA9" />
              <span>Zero cancellation fee • Pay directly to driver or via UPI after trip</span>
            </div>

            <div className="modal-footer row-btns">
              <button 
                type="button" 
                className="btn btn-outline-light"
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button type="submit" className="btn btn-teal flex-1" disabled={submitting}>
                {submitting ? 'Sending…' : 'Confirm Cab Booking'}
              </button>
            </div>
          </form>
        )}

        {/* Step 3: Confirmation */}
        {step === 3 && (
          <div className="modal-body text-center py-6">
            <div className="success-icon-box">
              <CheckCircle2 size={56} color="#00BBA9" />
            </div>
            <h4 className="confirm-title">Cab Booked Successfully!</h4>
            <p className="confirm-text">
              Thank you, <strong>{name || 'Rider'}</strong>. Your request reference is <strong>{requestId || 'pending'}</strong>.
            </p>
            <div className="driver-assign-card">
              <p>📍 Our team will call you shortly to confirm the driver and fare.</p>
              <p>📞 Call us: {CONTACT.tollFree}</p>
            </div>

            <button className="btn btn-teal w-full mt-6" onClick={handleReset}>
              Done & Return to Homepage
            </button>
          </div>
        )}
      </div>

      <style>{`
        .connect-bharat-landing {
          .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(7, 21, 43, 0.85);
            backdrop-filter: blur(8px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2000;
            padding: 20px;
          }

          .modal-card {
            background-color: #0C1B30;
            border: 1px solid rgba(0, 187, 169, 0.3);
            border-radius: 16px;
            width: 100%;
            max-width: 540px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
            overflow: hidden;
            color: #FFFFFF;
            /* Cap to the viewport and let the body scroll — the step 1 form is
               taller than a phone screen (and than a short laptop window). */
            max-height: calc(100vh - 40px);
            display: flex;
            flex-direction: column;
          }

          .modal-header {
            flex-shrink: 0;
          }

          .modal-body {
            overflow-y: auto;
          }

          .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding: 20px 24px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            background-color: #07152B;
          }

          .modal-badge {
            display: inline-block;
            font-size: 11px;
            font-weight: 600;
            color: #00BBA9;
            background: rgba(0, 187, 169, 0.12);
            padding: 2px 8px;
            border-radius: 4px;
            margin-bottom: 4px;
            text-transform: uppercase;
          }

          .modal-title {
            font-size: 20px;
            font-weight: 700;
            color: #FFFFFF;
            margin: 0;
          }

          .modal-close-btn {
            background: none;
            border: none;
            cursor: pointer;
            padding: 4px;
            border-radius: 6px;
          }
          .modal-close-btn:hover {
            background: rgba(255, 255, 255, 0.1);
          }

          .modal-body {
            padding: 24px;
            display: flex;
            flex-direction: column;
            gap: 16px;
          }

          .tab-pills {
            display: flex;
            background: rgba(255, 255, 255, 0.06);
            border-radius: 8px;
            padding: 4px;
            gap: 4px;
          }

          .tab-pill {
            flex: 1;
            background: none;
            border: none;
            color: #94A3B8;
            padding: 8px;
            font-size: 13px;
            font-weight: 500;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .tab-pill.active {
            background-color: #00BBA9;
            color: #FFFFFF;
            font-weight: 600;
          }

          .input-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }

          .section-sublabel {
            font-size: 13px;
            color: #CBD5E1;
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 8px;
            font-weight: 500;
          }

          .vehicle-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
          }

          .vehicle-card-item {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 10px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .vehicle-card-item:hover {
            border-color: rgba(0, 187, 169, 0.5);
          }

          .vehicle-card-item.selected {
            border-color: #00BBA9;
            background: rgba(0, 187, 169, 0.12);
          }

          .v-item-header {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;

          }

          .v-name {
            color: #FFFFFF;
          }

          .v-rate {
            color: #00BBA9;
          }

          .v-item-sub {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #94A3B8;
            margin-top: 4px;
          }

          .trip-summary-box {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .sum-item {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
          }

          .sum-label {
            color: #94A3B8;
          }

          .sum-val {
            color: #FFFFFF;
            font-weight: 500;
          }

          .sum-val.highlight {
            color: #00BBA9;
          }

          .sum-val.fare {
            color: #00BBA9;
            font-weight: 700;
            font-size: 14px;
          }

          .booking-error {
            background: rgba(239, 68, 68, 0.12);
            border: 1px solid rgba(239, 68, 68, 0.4);
            color: #FCA5A5;
            font-size: 13px;
            padding: 10px 12px;
            border-radius: 8px;
          }

          .security-notice {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: #94A3B8;
            background: rgba(0, 187, 169, 0.06);
            padding: 8px 12px;
            border-radius: 6px;
          }

          .row-btns {
            display: flex;
            gap: 10px;
          }

          .flex-1 {
            flex: 1;
          }

          .success-icon-box {
            display: flex;
            justify-content: center;
            margin-bottom: 12px;
          }

          .confirm-title {
            font-size: 22px;
            font-weight: 700;
            color: #FFFFFF;
            margin-bottom: 6px;
          }

          .confirm-text {
            font-size: 14px;
            color: #CBD5E1;
          }

          .driver-assign-card {
            background: rgba(0, 187, 169, 0.08);
            border: 1px solid rgba(0, 187, 169, 0.2);
            border-radius: 10px;
            padding: 14px;
            margin-top: 14px;
            text-align: left;
            font-size: 13px;
            color: #E2E8F0;
            display: flex;
            flex-direction: column;
            gap: 6px;
          }

          @media (max-width: 576px) {
            /* Full-screen sheet on phones — a centred card with 20px gutters wastes
               the width the 4 trip tabs and the vehicle list need. */
            .modal-overlay {
              padding: 0;
              align-items: stretch;
            }
            .modal-card {
              max-width: 100%;
              max-height: 100vh;
              border: none;
              border-radius: 0;
            }
            .modal-header {
              padding: 14px 16px;
            }
            .modal-title {
              font-size: 17px;
            }
            .modal-body {
              padding: 16px;
              gap: 14px;
            }
            .tab-pills {
              flex-wrap: wrap;
            }
            .tab-pill {
              flex: 1 1 44%;
              font-size: 12.5px;
            }
            .input-row, .vehicle-grid {
              grid-template-columns: 1fr;
            }
            .row-btns {
              flex-direction: column-reverse;
            }
            .row-btns .btn {
              width: 100%;
            }
            .confirm-title {
              font-size: 19px;
            }
          }

          .py-6 {
            padding-top: 24px;
            padding-bottom: 24px;
          }

          .text-center {
            text-align: center;
          }

          .mt-6 {
            margin-top: 24px;
          }
      
        }
      `}</style>
    </div>
  );
};

export default BookingModal;
