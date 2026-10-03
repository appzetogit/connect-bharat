import { Router } from 'express';
import {
  getVehicleMapIconImage,
  getVehicleMapIcons,
} from '../controllers/vehicleMapIconController.js';
import { getPublicBanners } from '../../admin/promotions/controllers/promotionsController.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  loginRateLimit,
  routeRateLimit,
  otpSendRateLimit,
  otpVerifyRateLimit,
  paymentOrderRateLimit,
} from '../../middlewares/rateLimitMiddleware.js';
import {
  cancelMyBusBooking,
  createBusBookingOrder,
  createRentalAdvancePaymentOrder,
  createPhonePeRentalAdvancePaymentOrder,
  payRentalAdvanceWithWallet,
  createRentalBookingRequest,
  createRentalQuoteRequest,
  createRazorpayWalletTopupOrder,
  createPhonePeWalletTopupOrder,
  handleUserRazorpayWalletTopupCallback,
  getBusSeatLayout,
  getBusRouteSuggestions,
  getMyBusBookingById,
  listMyBusBookings,
  getUserWallet,
  getCurrentUser,
  getUserNotifications,
  deleteUserNotification,
  endMyActiveRentalRide,
  getIntercityPackageCatalog,
  clearAllUserNotifications,
  getMyActiveRentalBooking,
  listPublicServiceLocations,
  listPublicServiceStores,
  listMyRentalBookings,
  loginUser,
  registerUser,
  requestAccountDeletion,
  saveUserFcmToken,
  submitWebsiteBooking,
  searchBuses,
  signupUser,
  startUserOtpRequest,
  submitMyBusBookingReview,
  topupUserWallet,
  transferUserWalletToDriver,
  transferUserWallet,
  updateMyActiveRentalLocation,
  updateCurrentUser,
  uploadUserProfileImage,
  verifyBusBookingPayment,
  verifyRentalAdvancePayment,
  verifyPhonePeRentalAdvancePayment,
  verifyRazorpayWalletTopup,
  verifyPhonePeWalletTopup,
  verifyUserOtpRequest,
  verifyUserPhoneForOtpLogin,
  getAvailableSubscriptionPlans,
  getMySubscriptions,
  buySubscription,
  getRoute,
  getSetPrices,
  getZones,
} from '../controllers/userController.js';
import {
  searchPoolingRoutes,
  getPoolingRouteDetails,
  createPoolingBookingOrder,
  verifyPoolingBookingPayment,
  createPoolingBooking,
  getMyPoolingBookings
} from '../controllers/poolingController.js';
import { getAppBootstrap, getAppModules, getGeneralSettingsCategory, getGoodsTypes, getPublicRentalVehicleCatalog, getPublicVehicleTypeCatalog, getPublicLandingContent, getPublicLegalContent, submitWebsiteEnquiry } from '../../admin/controllers/adminController.js';
import { getPublicCancellationReasons } from '../../admin/controllers/cancellationReasonController.js';
import { triggerUserSosAlert } from '../../safety/controllers/safetyController.js';
import { requireUploadAuth } from '../../middlewares/uploadAuthMiddleware.js';

export const userRouter = Router();

userRouter.get('/bootstrap', asyncHandler(getAppBootstrap));
userRouter.get('/app-modules', asyncHandler(getAppModules));
userRouter.get('/settings/:category', asyncHandler(getGeneralSettingsCategory));
// Admin-managed reasons the rider picks from when cancelling a trip.
userRouter.get('/cancellation-reasons', getPublicCancellationReasons);
userRouter.get('/intercity-packages', asyncHandler(getIntercityPackageCatalog));
userRouter.get('/goods-types', asyncHandler(getGoodsTypes));
userRouter.get('/vehicle-types', asyncHandler(getPublicVehicleTypeCatalog));
userRouter.get('/landing-content', asyncHandler(getPublicLandingContent));
// Marker art for the map. The controller has existed since the marker work
// landed but was never routed, so both apps 404'd and silently fell back to
// bundled silhouettes - admin-uploaded vehicle art never reached a map.
userRouter.get('/vehicle-map-icons', asyncHandler(getVehicleMapIcons));
userRouter.get('/vehicle-map-icons/:vehicleId/image', asyncHandler(getVehicleMapIconImage));
// Home-screen promo banners, which were only exposed under /admin, so the
// app's request 404'd and the carousel stayed empty.
userRouter.get('/banners', asyncHandler(getPublicBanners));
userRouter.get('/legal-content', asyncHandler(getPublicLegalContent));
userRouter.get('/set-prices', asyncHandler(getSetPrices));
// Road routes for the maps. Authenticated and rate limited because every
// cache miss is a billed Directions call.
userRouter.get('/route', authenticate(['user', 'driver']), routeRateLimit, asyncHandler(getRoute));
userRouter.get('/zones', asyncHandler(getZones));
userRouter.get('/rental-vehicles', asyncHandler(getPublicRentalVehicleCatalog));
userRouter.get('/service-locations', asyncHandler(listPublicServiceLocations));
userRouter.get('/service-stores', asyncHandler(listPublicServiceStores));
userRouter.post('/rental-quote-requests', asyncHandler(createRentalQuoteRequest));
userRouter.post('/rental-bookings', authenticate(['user']), asyncHandler(createRentalBookingRequest));
userRouter.get('/rental-bookings', authenticate(['user']), asyncHandler(listMyRentalBookings));
userRouter.get('/rental-bookings/active', authenticate(['user']), asyncHandler(getMyActiveRentalBooking));
userRouter.post('/rental-bookings/:id/end', authenticate(['user']), asyncHandler(endMyActiveRentalRide));
userRouter.post('/rental-bookings/:id/location', authenticate(['user']), asyncHandler(updateMyActiveRentalLocation));
userRouter.post('/register', asyncHandler(registerUser));
userRouter.post('/signup', asyncHandler(signupUser));
userRouter.post('/login', loginRateLimit, asyncHandler(loginUser));
userRouter.post('/profile-image', requireUploadAuth, asyncHandler(uploadUserProfileImage));
userRouter.post('/auth/send-otp', otpSendRateLimit, asyncHandler(startUserOtpRequest));
userRouter.post('/auth/verify-otp', otpVerifyRateLimit, asyncHandler(verifyUserOtpRequest));
userRouter.post('/otp-login', otpVerifyRateLimit, asyncHandler(verifyUserPhoneForOtpLogin));
userRouter.post('/fcm-token', authenticate(['user']), asyncHandler(saveUserFcmToken));

// Public: booking enquiry from the marketing site. Rate limited because it
// is unauthenticated and writes a record.
userRouter.post('/booking-request', loginRateLimit, asyncHandler(submitWebsiteBooking));
// Public marketing forms. Same rate limit as the booking form - both are
// unauthenticated and equally worth spamming.
userRouter.post('/enquiry', loginRateLimit, asyncHandler(submitWebsiteEnquiry));
userRouter.get('/me', authenticate(['user']), asyncHandler(getCurrentUser));
userRouter.patch('/me', authenticate(['user']), asyncHandler(updateCurrentUser));
userRouter.get('/subscriptions/plans', authenticate(['user']), asyncHandler(getAvailableSubscriptionPlans));
userRouter.get('/subscriptions/me', authenticate(['user']), asyncHandler(getMySubscriptions));
userRouter.post('/subscriptions/purchase', authenticate(['user']), asyncHandler(buySubscription));
userRouter.post('/me/delete-request', authenticate(['user']), asyncHandler(requestAccountDeletion));
userRouter.get('/notifications', authenticate(['user']), asyncHandler(getUserNotifications));
userRouter.delete('/notifications/:id', authenticate(['user']), asyncHandler(deleteUserNotification));
userRouter.delete('/notifications', authenticate(['user']), asyncHandler(clearAllUserNotifications));
userRouter.post('/sos', authenticate(['user']), asyncHandler(triggerUserSosAlert));
userRouter.get('/wallet', authenticate(['user']), asyncHandler(getUserWallet));
userRouter.post('/wallet/topup', authenticate(['user']), asyncHandler(topupUserWallet));
userRouter.post('/wallet/transfer', authenticate(['user']), asyncHandler(transferUserWallet));
userRouter.post('/wallet/transfer/driver', authenticate(['user']), asyncHandler(transferUserWalletToDriver));
userRouter.post('/wallet/razorpay/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createRazorpayWalletTopupOrder));
userRouter.post('/wallet/razorpay/verify', authenticate(['user']), asyncHandler(verifyRazorpayWalletTopup));
userRouter.post('/wallet/razorpay/callback', asyncHandler(handleUserRazorpayWalletTopupCallback));
userRouter.get('/wallet/razorpay/callback', asyncHandler(handleUserRazorpayWalletTopupCallback));
userRouter.post('/wallet/phonepe/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createPhonePeWalletTopupOrder));
userRouter.get('/wallet/phonepe/status/:merchantTransactionId', authenticate(['user']), asyncHandler(verifyPhonePeWalletTopup));
userRouter.post('/rental-advance/razorpay/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createRentalAdvancePaymentOrder));
userRouter.post('/rental-advance/razorpay/verify', authenticate(['user']), asyncHandler(verifyRentalAdvancePayment));
userRouter.post('/rental-advance/phonepe/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createPhonePeRentalAdvancePaymentOrder));
userRouter.get('/rental-advance/phonepe/status/:merchantTransactionId', authenticate(['user']), asyncHandler(verifyPhonePeRentalAdvancePayment));
userRouter.post('/rental-advance/wallet', authenticate(['user']), asyncHandler(payRentalAdvanceWithWallet));
userRouter.get('/buses/routes', authenticate(['user']), asyncHandler(getBusRouteSuggestions));
userRouter.get('/buses/search', authenticate(['user']), asyncHandler(searchBuses));
userRouter.get('/buses/:id/seats', authenticate(['user']), asyncHandler(getBusSeatLayout));
userRouter.get('/bus-bookings', authenticate(['user']), asyncHandler(listMyBusBookings));
userRouter.get('/bus-bookings/:id', authenticate(['user']), asyncHandler(getMyBusBookingById));
userRouter.post('/bus-bookings/:id/review', authenticate(['user']), asyncHandler(submitMyBusBookingReview));
userRouter.post('/bus-bookings/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createBusBookingOrder));
userRouter.post('/bus-bookings/verify', authenticate(['user']), paymentOrderRateLimit, asyncHandler(verifyBusBookingPayment));
userRouter.post('/bus-bookings/:id/cancel', authenticate(['user']), asyncHandler(cancelMyBusBooking));

userRouter.get('/pooling/search', authenticate(['user']), asyncHandler(searchPoolingRoutes));
userRouter.get('/pooling/routes/:id', authenticate(['user']), asyncHandler(getPoolingRouteDetails));
userRouter.post('/pooling/bookings/order', authenticate(['user']), paymentOrderRateLimit, asyncHandler(createPoolingBookingOrder));
userRouter.post('/pooling/bookings/verify', authenticate(['user']), paymentOrderRateLimit, asyncHandler(verifyPoolingBookingPayment));
userRouter.post('/pooling/bookings', authenticate(['user']), asyncHandler(createPoolingBooking));
userRouter.get('/pooling/bookings', authenticate(['user']), asyncHandler(getMyPoolingBookings));
