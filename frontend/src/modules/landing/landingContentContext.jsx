import { createContext, useContext, useMemo } from 'react';
import useLandingContent from './useLandingContent';
import { LANDING_FALLBACK } from './landingFallback';
import { useSettings } from '../../shared/context/SettingsContext';

/**
 * Makes the CMS content available to every landing page.
 *
 * Before this, `siteConfig.js` held a second hardcoded copy of the contact
 * details and launch cities that most pages imported directly, so editing them
 * in the admin panel only changed the home page while the footer, contact page
 * and booking modal kept showing the old values. Everything now reads from here,
 * and `useLandingContent` is called once in the shell rather than per page.
 */

const LandingContentContext = createContext(null);

const DEFAULT_WA_MESSAGE = "Hi Connect Bharat, I'd like to book a ride.";

/// The file the CMS brand block shipped with. An untouched field still holds
/// it, so it counts as "not set" rather than as a deliberate choice.
const BUNDLED_LOGO = '/connect-bharat-logo.jpg';

/// The logo the site shows: one set in Website Content if anyone has set one
/// there, otherwise the logo from General Settings, otherwise the bundled file.
///
/// The admin panel has two logo fields and the site used to read only the
/// Website Content one - which nobody had filled in - so uploading a logo in
/// General Settings, the obvious place, never changed the website at all.
/// Either upload now works; the page-specific one wins when both are set.
const resolveLogo = (brandLogo, generalLogo) => {
  const override = String(brandLogo || '').trim();
  if (override && override !== BUNDLED_LOGO) {
    return override;
  }
  return generalLogo || BUNDLED_LOGO;
};

const buildValue = (content, generalLogo) => ({
  ...content,
  brand: { ...(content?.brand || {}), logo: resolveLogo(content?.brand?.logo, generalLogo) },
  // wa.me needs digits only with a country code; the display value is separate.
  waLink: (message = DEFAULT_WA_MESSAGE) =>
    `https://wa.me/${content?.contact?.whatsapp || ''}?text=${encodeURIComponent(message)}`,
});

export function LandingContentProvider({ children }) {
  const content = useLandingContent();
  // Optional chaining: a page rendered outside the settings provider still gets
  // the CMS logo or the bundled one rather than failing.
  const generalLogo = useSettings()?.settings?.general?.logo || '';
  const value = useMemo(() => buildValue(content, generalLogo), [content, generalLogo]);

  return <LandingContentContext.Provider value={value}>{children}</LandingContentContext.Provider>;
}

/**
 * Falls back to the bundled copy when used outside the provider, so a page
 * rendered on its own still shows contact details rather than blanks.
 */
export function useLanding() {
  return useContext(LandingContentContext) || buildValue(LANDING_FALLBACK);
}

/** Convenience for the many components that only need contact details. */
export function useSiteContact() {
  const { contact, waLink } = useLanding();
  return { contact: contact || LANDING_FALLBACK.contact, waLink };
}
