import { useEffect, useRef, useState } from 'react';
import { Camera, ScanLine, X } from 'lucide-react';
import { inputClass } from './format';

/**
 * The AWB input every scan screen uses.
 *
 * Keyboard-wedge scanners "type" the barcode and press Enter, so an
 * autofocused input that submits on Enter is all a USB/Bluetooth scanner
 * needs. Focus is pulled back after each submit so the operator can scan
 * parcel after parcel without touching the mouse.
 *
 * Camera scanning uses the browser's built-in BarcodeDetector (Chrome on
 * Android, recent desktop Chrome) and needs no library; the button only
 * appears where the API exists.
 */
const AWB_PATTERN = /ZB[A-Z]{3}\d{13}/;

const extractAwb = (raw = '') => {
  const text = String(raw).toUpperCase();
  return (text.match(AWB_PATTERN) || [text.replace(/[^A-Z0-9]/g, '')])[0];
};

const CameraScanner = ({ onDetected, onClose }) => {
  const videoRef = useRef(null);
  const detectedRef = useRef(onDetected);
  const [error, setError] = useState('');
  useEffect(() => {
    detectedRef.current = onDetected;
  });

  useEffect(() => {
    let stream;
    let frame;
    let stopped = false;
    const start = async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const hit = codes.find((code) => AWB_PATTERN.test(String(code.rawValue).toUpperCase()));
            if (hit) {
              detectedRef.current(extractAwb(hit.rawValue));
              return;
            }
          } catch {
            // A frame that cannot be read yet; keep going.
          }
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (cameraError) {
        setError(cameraError?.message || 'Camera unavailable');
      }
    };
    start();
    return () => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <button type="button" onClick={onClose} className="absolute top-4 right-4 text-white"><X /></button>
      {error ? <p className="text-white text-sm">{error}</p> : <video ref={videoRef} className="max-w-full max-h-[70vh] rounded-lg" muted playsInline />}
      <p className="text-white/70 text-xs mt-3">Point the camera at the label QR or barcode</p>
    </div>
  );
};

const ScanInput = ({ onScan, placeholder = 'Scan or type AWB and press Enter', disabled = false, autoFocus = true }) => {
  const [value, setValue] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef(null);
  const cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;

  const submit = async (raw) => {
    const awb = extractAwb(raw);
    if (!awb) return;
    setValue('');
    await onScan(awb);
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus();
  }, [autoFocus, disabled]);

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <ScanLine size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit(value);
            }
          }}
          placeholder={placeholder}
          className={`${inputClass} pl-9 font-mono text-[14px] tracking-wide`}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {cameraSupported && (
        <button type="button" onClick={() => setCameraOpen(true)} className="px-3 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50" title="Scan with camera">
          <Camera size={16} />
        </button>
      )}
      {cameraOpen && (
        <CameraScanner
          onClose={() => setCameraOpen(false)}
          onDetected={(awb) => {
            setCameraOpen(false);
            submit(awb);
          }}
        />
      )}
    </div>
  );
};

export default ScanInput;
