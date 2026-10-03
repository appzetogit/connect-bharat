import express, { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { phonePeWebhook, razorpayWebhook } from '../controllers/paymentController.js';

/// Gateway webhooks, mounted in src/app.js at /api/v1/webhooks and
/// /api/webhooks BEFORE the global JSON parser.
///
/// Razorpay signs the exact bytes it sent, so the body must reach the
/// handler raw; once express.json has parsed and re-serialised it, the
/// signature no longer matches. No auth middleware: the signature (Razorpay)
/// or the Authorization hash (PhonePe) is the authentication.
export const webhookRouter = Router();

const rawJson = express.raw({ type: ['application/json', 'application/*+json'], limit: '1mb' });

webhookRouter.post('/razorpay', rawJson, asyncHandler(razorpayWebhook));
webhookRouter.post('/phonepe', rawJson, asyncHandler(phonePeWebhook));
