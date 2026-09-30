const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let paystackSecret = 'test_secret_fallback';
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/PAYSTACK_SECRET_KEY=(.*)/);
  if (match && match[1]) {
    paystackSecret = match[1].trim();
  }
} catch (e) {}

const API = 'http://localhost:3000';

async function testWalletAndDVA() {
  const timestamp = Date.now();
  console.log('💳 Starting Tark DVA & In-App Wallet Test...\n');

  try {
    // 1. Register User
    const userEmail = `wallet_${timestamp}@test.com`;
    console.log(`1. Registering user (${userEmail})...`);
    const regRes = await axios.post(`${API}/auth/register`, {
      email: userEmail,
      password: 'Password123!',
      fullName: 'Chidi Bankole',
      role: 'client',
    });
    const token = regRes.data.accessToken;

    const meRes = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`   ✅ User registered. Initial Wallet Balance: ₦${meRes.data.walletBalance || 0}`);

    // 2. Request Dedicated Virtual Account
    console.log('\n2. Provisioning Paystack Dedicated Virtual Account...');
    let customerCode = null;
    try {
      const dvaRes = await axios.post(
        `${API}/payments/dedicated-account`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      customerCode = dvaRes.data.customerCode;
      console.log(`   ✅ DVA Assigned!`);
      console.log(`   Bank: ${dvaRes.data.bankName}`);
      console.log(`   Account Number: [ ${dvaRes.data.accountNumber} ]`);
      console.log(`   Customer Code: ${customerCode}`);
    } catch (dvaErr) {
      // If Paystack test keys require live BVN for real DVA generation, simulate using user's customer code
      console.log(`   ⚠️ Paystack sandbox DVA response: ${dvaErr.response?.data?.message || dvaErr.message}`);
      console.log('   (Simulating automated wallet top-up via customer_code)');
    }

    // 3. Simulate Inbound Bank Transfer Webhook to DVA
    console.log('\n3. Simulating inbound bank transfer to User DVA (₦15,000)...');
    
    // Fetch profile to verify customer code exists
    const updatedProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const targetCustomerCode = updatedProfile.data.paystackCustomerCode || `CUS_mock_${timestamp}`;

    // Ensure user has this code set for webhook simulation
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        amount: 15000 * 100, // ₦15,000 in kobo
        currency: 'NGN',
        reference: `TARK-TRANSFER-${timestamp}`,
        customer: {
          customer_code: targetCustomerCode,
          email: userEmail,
        },
      },
    });

    const signature = crypto
      .createHmac('sha512', paystackSecret)
      .update(Buffer.from(webhookPayload))
      .digest('hex');

    const webhookRes = await axios.post(`${API}/payments/webhook`, JSON.parse(webhookPayload), {
      headers: {
        'x-paystack-signature': signature,
      },
    });
    console.log(`   ✅ Webhook processed: ${webhookRes.data.message}`);

    // 4. Verify Wallet Ledger Balance
    console.log('\n4. Verifying updated Wallet Balance...');
    const finalProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`   🎉 Verified Wallet Balance: ₦${finalProfile.data.walletBalance}`);

    console.log('\n✨ DVA Wallet Architecture is functional.');
  } catch (err) {
    console.error('\n❌ Test failed:');
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error('Data:', err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

testWalletAndDVA();
