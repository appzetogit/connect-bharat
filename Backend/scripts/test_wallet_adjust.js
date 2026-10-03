
import mongoose from 'mongoose';
import { Driver } from '/var/www/connect-bharat/Backend/src/modules/taxi/driver/models/Driver.js';
import * as adminService from '/var/www/connect-bharat/Backend/src/modules/taxi/admin/services/adminService.js';

await mongoose.connect('mongodb://127.0.0.1:27017/connect_bharat');

const driver = await Driver.findOne({ phone: '7470311228' });
console.log(`Testing with driver ${driver.name} (id: ${driver._id}, current balance: ${driver.wallet?.balance})`);

// 1. Credit 50
const r1 = await adminService.adjustDriverWallet(driver._id, { amount: 50, operation: 'credit', description: 'Test credit +50' });
console.log("Credit result:", r1);

// 2. Debit 50
const r2 = await adminService.adjustDriverWallet(driver._id, { amount: 50, operation: 'debit', description: 'Test debit -50' });
console.log("Debit result:", r2);

// 3. Set exact balance to 500
const r3 = await adminService.adjustDriverWallet(driver._id, { amount: 500, operation: 'set', description: 'Set balance to 500' });
console.log("Set result:", r3);

// 4. List history
const history = await adminService.listDriverWalletHistory(driver._id);
console.log("History records count:", history.results.length, "Current balance in history:", history.balance);

await mongoose.disconnect();
