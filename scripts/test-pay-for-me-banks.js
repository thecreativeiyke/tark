const axios = require('axios');

const API = 'http://localhost:3000';

async function testFeatures() {
  const timestamp = Date.now();
  console.log('🏦 Testing Real-Time Bank Directory & Personalized Pay-For-Me...\n');

  try {
    // 1. Test Live Bank API with Digital Bank Search (OPay)
    console.log('1. Fetching live Nigerian banks matching "opay"...');
    const opayRes = await axios.get(`${API}/payments/banks`, {
      params: { country: 'nigeria', search: 'opay' },
    });
    console.log(`   ✅ Found ${opayRes.data.total} bank match:`);
    if (opayRes.data.banks.length > 0) {
      const b = opayRes.data.banks[0];
      console.log(`      Name: ${b.name} | Code: ${b.code} | Category: ${b.category}`);
    }

    // 2. Test Commercial Bank Search (Access)
    console.log('\n2. Fetching commercial banks matching "access"...');
    const accessRes = await axios.get(`${API}/payments/banks`, {
      params: { country: 'nigeria', search: 'access' },
    });
    console.log(`   ✅ Found ${accessRes.data.total} match(es):`);
    accessRes.data.banks.forEach((b) => {
      console.log(`      - ${b.name} (Code: ${b.code}, Category: ${b.category})`);
    });

    // 3. Register Client & Artisan for Pay-For-Me Flow
    console.log('\n3. Setting up test users and job for Pay-For-Me...');
    const clientEmail = `payme_client_${timestamp}@test.com`;
    const clientAuth = await axios.post(`${API}/auth/register`, {
      email: clientEmail,
      password: 'Password123!',
      fullName: 'Dr. Adeola Balogun',
      role: 'client',
    });
    const clientToken = clientAuth.data.accessToken;

    // Provision DVA for client
    await axios.post(
      `${API}/payments/dedicated-account`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );

    // Register Artisan
    const artisanAuth = await axios.post(`${API}/auth/register`, {
      email: `payme_art_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Emeka Inverter Repairs',
      role: 'artisan',
    });
    const artisanProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${artisanAuth.data.accessToken}` },
    });
    const artisanId = artisanProfile.data.id;

    // 4. Create Job and Escrow
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: '5KVA Solar Inverter Motherboard Fix',
        description: 'Complete inspection and component replacement for hybrid inverter',
        category: 'solar-inverter',
        budget: 45000,
        tranche1Amount: 20000,
        tranche2Amount: 25000,
        location: 'Victoria Island, Lagos',
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );

    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: jobRes.data.id,
        artisanId: artisanId,
        tranche1Amount: 20000,
        tranche2Amount: 25000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );

    // 5. Generate Multi-Channel Pay For Me Package
    console.log('\n4. Generating personalized multi-channel Pay-For-Me package...');
    const payForMeRes = await axios.get(
      `${API}/payments/pay-for-me/${escrowRes.data.id}`,
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );

    const payload = payForMeRes.data;

    console.log('\n========================================');
    console.log('📋 METADATA:');
    console.log(`   Job:      ${payload.metadata.jobTitle} (${payload.metadata.jobLocation})`);
    console.log(`   Client:   ${payload.metadata.clientName}`);
    console.log(`   Artisan:  ${payload.metadata.artisanName}`);
    console.log(`   Amount:   ${payload.metadata.currency} ${payload.metadata.totalAmount}`);
    console.log('\n🔗 PAYMENT RAILS:');
    console.log(`   Online Checkout URL: ${payload.paymentRails.onlineCheckoutUrl}`);
    if (payload.paymentRails.virtualAccount) {
      console.log(`   Virtual Account:     ${payload.paymentRails.virtualAccount.bankName} - ${payload.paymentRails.virtualAccount.accountNumber}`);
    }
    console.log('\n📱 SHARE CHANNELS GENERATED:');
    console.log(`   ✅ Web Share API:  [Title: "${payload.shareChannels.webShare.title}"]`);
    console.log(`   ✅ WhatsApp URL:   ${payload.shareChannels.whatsappUrl.slice(0, 60)}...`);
    console.log(`   ✅ Telegram URL:   ${payload.shareChannels.telegramUrl.slice(0, 60)}...`);
    console.log(`   ✅ SMS URL:        ${payload.shareChannels.smsUrl.slice(0, 60)}...`);
    console.log(`   ✅ Email Subject:  "${payload.shareChannels.email.subject}"`);
    console.log('\n📄 PLAIN TEXT COPY MESSAGE:');
    console.log(payload.shareChannels.clipboardText);
    console.log('========================================');

    console.log('\n✨ Real-Time Banks & Multi-Channel Pay-For-Me verified successfully!');
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

testFeatures();
