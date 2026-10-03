/**
 * Shipped defaults for the in-ride voice announcements.
 *
 * The apps read this through `GET /users/settings/ride-voice`, so the wording,
 * the timings and the set of languages are all changeable from the admin panel
 * without publishing a new APK.
 *
 * `messages` is deliberately a free-form map keyed by the same language codes
 * the apps already use (`locale_code`: en, hi, kn, ta, te ...). Adding a
 * language is a new key here or a new key saved from the panel — never a schema
 * change and never a Flutter release.
 *
 * Templates support `{variable}` placeholders. Only `{minutes}` is substituted
 * today; the client resolves any variable it knows and leaves the rest alone,
 * so `{destination}` / `{driver_name}` can be introduced later from the panel.
 */
export const createDefaultRideVoiceSettings = () => ({
  enabled: true,

  /// Language used when the rider's app language has no template configured.
  /// Never let a missing translation mean silence for a rider who did pick a
  /// language we simply have not written yet.
  fallback_language: 'en',

  welcome: {
    enabled: true,
    /// Minutes after the trip actually starts (RIDE_STARTED), not booking or
    /// driver acceptance.
    delay_minutes: 5,
    messages: {
      en: 'Ladies and gentlemen, welcome aboard Connect Bharat. Sit back and relax. We expect to reach your destination in approximately {minutes} minutes. Thank you.',
      hi: 'लेडीज एंड जेंटलमैन, Connect Bharat में आपका स्वागत है। आराम से बैठें। हम लगभग {minutes} मिनट में आपकी मंजिल तक पहुंच जाएंगे। धन्यवाद।',
      kn: 'ಪ್ರಿಯ ಗ್ರಾಹಕರೇ, Connect Bharat ಗೆ ಸ್ವಾಗತ. ಆರಾಮವಾಗಿರಿ. ನಾವು ಸುಮಾರು {minutes} ನಿಮಿಷಗಳಲ್ಲಿ ನಿಮ್ಮ ಗಮ್ಯಸ್ಥಾನವನ್ನು ತಲುಪುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು.',
    },
  },

  /// Spoken once, part-way into the trip, to tell the rider the cabin is set up
  /// for them and that the driver can change it. Time-based like the welcome:
  /// the app has no way to know whether the air conditioning is actually
  /// running, so this reads as an offer rather than a claim about the car.
  comfort: {
    enabled: true,
    delay_minutes: 10,
    messages: {
      en: 'The air conditioning is on for your comfort. If you would like it adjusted, please let your driver know.',
      hi: '\u0906\u092a\u0915\u0940 \u0938\u0941\u0935\u093f\u0927\u093e \u0915\u0947 \u0932\u093f\u090f \u090f\u0938\u0940 \u091a\u093e\u0932\u0942 \u0939\u0948\u0964 \u0905\u0917\u0930 \u0906\u092a \u0907\u0938\u0947 \u0915\u092e \u092f\u093e \u091c\u093c\u094d\u092f\u093e\u0926\u093e \u0915\u0930\u093e\u0928\u093e \u091a\u093e\u0939\u0947\u0902, \u0924\u094b \u0915\u0943\u092a\u092f\u093e \u0905\u092a\u0928\u0947 \u0921\u094d\u0930\u093e\u0907\u0935\u0930 \u0915\u094b \u092c\u0924\u093e\u090f\u0902\u0964',
      kn: '\u0ca8\u0cbf\u0cae\u0ccd\u0cae \u0c85\u0ca8\u0cc1\u0c95\u0cc2\u0cb2\u0c95\u0ccd\u0c95\u0cbe\u0c97\u0cbf \u0c8e.\u0cb8\u0cbf. \u0c9a\u0cbe\u0cb2\u0ca8\u0cc6\u0caf\u0cb2\u0ccd\u0cb2\u0cbf\u0ca6\u0cc6. \u0c85\u0ca6\u0ca8\u0ccd\u0ca8\u0cc1 \u0cb9\u0cca\u0c82\u0ca6\u0cbf\u0cb8\u0cac\u0cc7\u0c95\u0cbf\u0ca6\u0ccd\u0ca6\u0cb0\u0cc6, \u0ca6\u0caf\u0cb5\u0cbf\u0c9f\u0ccd\u0c9f\u0cc1 \u0ca8\u0cbf\u0cae\u0ccd\u0cae \u0c9a\u0cbe\u0cb2\u0c95\u0cb0\u0cbf\u0c97\u0cc6 \u0ca4\u0cbf\u0cb3\u0cbf\u0cb8\u0cbf.',
    },
  },

  arrival: {
    enabled: true,
    /// Spoken once, the first time the remaining ETA drops to or below this.
    trigger_remaining_minutes: 10,
    messages: {
      en: 'Attention, Connect Bharat will be arriving at your destination in {minutes} minutes. Please check your belongings. It was a pleasure serving you. Thank you.',
      hi: 'ध्यान दें, Connect Bharat {minutes} मिनट में आपकी मंजिल तक पहुंच जाएगी। अपना सामान चेक कर लें। आपके साथ सफर करके अच्छा लगा। शुक्रिया।',
      kn: 'ಗಮನಿಸಿ, Connect Bharat ಇನ್ನು {minutes} ನಿಮಿಷಗಳಲ್ಲಿ ನಿಮ್ಮ ಗಮ್ಯಸ್ಥಾನವನ್ನು ತಲುಪಲಿದೆ. ನಿಮ್ಮ ಸಾಮಗ್ರಿಗಳನ್ನು ಪರಿಶೀಲಿಸಿ. ನಿಮ್ಮೊಂದಿಗೆ ಪ್ರಯಾಣಿಸಿದ್ದು ನಮಗೆ ಸಂತೋಷ. ಧನ್ಯವಾದಗಳು.',
    },
  },

  /// Playback tuning, exposed so the panel can slow the voice down or lower it
  /// without a release. Clamped client-side.
  speech: {
    rate: 0.5,
    pitch: 1.0,
    volume: 1.0,
  },
});
