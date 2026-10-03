export const createDefaultBusinessSettings = () => ({
  scope: 'default',
  general: {
    app_name: 'Appzeto',
    contact_phone_1: '0000000000',
    contact_phone_2: '0000000000',
    contact_booking_number: '9999999999',
    footer_1: '2024 © Appzeto.',
    footer_2: 'Design & Develop by Appzeto',
    default_lat: '22.7196',
    default_lng: '75.8577',
    logo: '',
    favicon: '',
  },
  customization: {
    admin_theme_color: '#405189',
    landing_theme_color: '#0ab39c',
    sidebar_text_color: '#ffffff',
    default_currency_code_for_mobile_app: 'INR',
    currency_symbol: '₹',
    disp_sidebar_bg: '#000000',
    disp_side_text: '#000000',
    enable_waze_navigation: '1',
    show_instant_ride_feature_on_mobile_app: '1',
    enable_outstation_round_trip: '1',
    show_incentive_feature_for_driver: '1',
    enable_driver_loyalty: '1',
    enable_country_restrict_on_map: '1',
    enable_owner_module: '1',
    show_ride_otp: '1',
    enable_delivery_otp_load: '1',
    enable_delivery_otp_unload: '1',
    show_ride_without_destination: '1',
    enable_web_booking_feature: '1',
    enable_sub_vehicle_feature: '1',
    enable_landing_site: '1',
    enable_additional_charge_feature: '1',
    enable_driver_disapprove_on_update: '1',
    enable_support_ticket_feature: '1',
    enable_map_appearance_change_on_mobile_app: '1',
    enable_driver_leaderboard_feature: '1',
    enable_multiple_ride_feature: '1',
    enable_max_dist_feature: '1',
    enable_fixed_fare: '1',

    // Security gates (services/securitySettingsService.js). Off = today's
    // behaviour; require_upload_auth is the one that defaults secure.
    enable_ride_start_otp_verification: '0',
    enforce_delivery_otp: '0',
    require_driver_approval: '0',
    strict_admin_permissions: '0',
    require_upload_auth: '1',

    // Sign-in Toggles
    user_email_login: '1',
    user_email_otp: '1',
    user_email_password: '1',
    user_mobile_login: '1',
    user_mobile_otp: '1',
    user_mobile_password: '1',
    driver_email_login: '1',
    driver_email_otp: '1',
    driver_email_password: '1',
    driver_mobile_login: '1',
    driver_mobile_otp: '1',
    driver_mobile_password: '1',
    owner_email_login: '1',
    owner_email_otp: '1',
    owner_email_password: '1',
    owner_mobile_login: '1',
    owner_mobile_otp: '1',
    owner_mobile_password: '1',
  },
  transport_ride: {
    enable_bus_service: '0',
    require_admin_approval_to_end_rental: '0',
    trip_dispatch_type: '1',
    maximum_time_for_accept_reject_bidding_ride: '60',
    maximum_time_for_find_drivers_for_bitting_ride: '300',
    maximum_time_for_find_drivers_for_regular_ride: '300',
    trip_accept_reject_duration_for_driver: '15',
    driver_search_radius: '5',
    // How far out the rider's map draws the online-driver markers, in km.
    // Separate from driver_search_radius, which is how far dispatch will
    // actually reach for a driver: a marker eight km away is not "who is
    // around me", and the client asked for one km.
    nearby_driver_marker_radius: '1',
    bidding_ride_maximum_distance: '50',
    user_can_make_a_ride_after_x_miniutes: '15',
    minimum_time_for_search_drivers_for_schedule_ride: '1',
    minimum_time_for_starting_trip_drivers_for_schedule_ride: '15',
    can_round_the_bill_values: '1',
    enable_shipment_load_feature: '1',
    enable_shipment_unload_feature: '1',
    enable_digital_signature: '1',
    enable_eta_price_on_complete: '1',
    enable_secondary_ride: '0',
    max_dist_secondary_ride: '2',
    enable_my_route_booking_feature: '0',
    how_many_times_a_driver_can_enable_the_my_route_booking_per_day: '1',
    // Charge the Price Hike windows and zone peak surge on real fares. Off by
    // default: the hike windows were display-only for a long time, and some
    // are still configured live.
    enable_surge_pricing: '0',
    // Whose number a taxi or outstation fare books at. 'server' prices the trip
    // from the Set Price row and ignores the app's figure; 'client' is the old
    // behaviour, kept as an escape hatch while the apps move to /rides/estimate.
    fare_source: 'server',
    // A round-trip intercity package costs this many one-way fares. 1.8 is what
    // the apps have always quoted.
    outstation_round_trip_multiplier: '1.8',
  },
  bid_ride: {
    // The master switch, and which services may be bid on at all. Both are
    // read by biddingPolicyService; an absent bidding_services means every
    // service, so an install that predates these keys keeps its behaviour.
    bidding_enabled: '1',
    bidding_services: 'city,outstation,parcel',
    // Offer bidding on every vehicle, rather than only the ones an admin has
    // individually marked biddable on the vehicle type. On by default because
    // that is what the client asked for; switch it off and each vehicle's own
    // dispatch type decides again.
    bidding_all_vehicles: '1',
    // Show the "nobody is accepting at this fare - add more" card while a
    // rider waits, even when they did not switch bidding on at booking. They
    // start at exactly the fare they were quoted and only move if they choose
    // to. Outstation is excluded: handing pricing to the drivers is a
    // different thing to opt into.
    user_increment_always: '1',
    bidding_low_percentage: '10',
    bidding_high_percentage: '20',
    bidding_amount_increase_or_decrease: '10',
    user_bidding_low_percentage: '10',
    user_bidding_high_percentage: '20',
    user_bidding_amount_increase_or_decrease: '10',
    user_fare_increase_wait_minutes: '2',
  },

  // A daily pass a driver buys instead of paying commission per trip.
  //
  // Every rule here is a switch rather than a decision baked into the code,
  // because how a city is run changes: the same build has to support taking
  // only commission, only the pass, or both at once.
  //
  // Off by default, so nothing changes until an admin turns it on.
  driver_subscription: {
    // off - commission only, as before
    // subscription_only - a pass is required to receive rides
    // both - a driver may work on commission or buy a pass
    subscription_mode: 'off',
    // Waive the per-trip commission while a pass is active. The rider's
    // platform fee is not waived: that was never the driver's money.
    waive_commission: '1',
    // Waive the wallet minimum balance while a pass is active - the whole
    // point of a daily pass is not having to keep the wallet topped up.
    waive_wallet_minimum: '1',
    // A driver registered for several vehicle types: 'highest' charges the
    // dearest plan that covers any of them and lets them take every kind of
    // trip; 'driver_choice' lets them buy the cheaper pass and only receive
    // the vehicle types that pass covers.
    multi_vehicle_rule: 'highest',
    // How a driver may pay: wallet balance, the payment gateway, or both.
    payment_methods: 'wallet,gateway',
    // At the end of a cycle with no renewal: 'commission' puts the driver
    // back on the commission model, 'block' stops sending them rides.
    on_expiry: 'commission',
    // The cycle is a fixed clock window, not 24 hours from payment: buy at
    // noon and it still ends at 6am. Hour is local to the timezone below;
    // the servers run on UTC, so this is read explicitly rather than assumed.
    cycle_start_hour: '6',
    cycle_timezone: 'Asia/Kolkata',
  },
});
