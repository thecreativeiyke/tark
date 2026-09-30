const axios = require('axios');
const FormData = require('form-data');

const API = 'http://localhost:3000';

async function runFullLifecycle() {
  try {
    const timestamp = Date.now();

    // 1. Register Client & Artisan
    console.log('1. Registering test Client and Artisan...');
    const clientRes = await axios.post(`${API}/auth/register`, {
      email: `client_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Tark Test Client',
      role: 'client',
    });
    const clientToken = clientRes.data.accessToken;

    const artisanRes = await axios.post(`${API}/auth/register`, {
      email: `artisan_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Tark Test Artisan',
      role: 'artisan',
    });
    const artisanToken = artisanRes.data.accessToken;
    console.log('   ✅ Client & Artisan registered.');

    // 2. Client uploads diagnostic photo to R2
    console.log('\n2. Client uploading diagnostic photo to /media/job-diagnostics...');
    const dummyImageBuffer = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a7df77e80000000049454e44ae426082',
      'hex',
    );

    const clientForm = new FormData();
    clientForm.append('files', dummyImageBuffer, {
      filename: `generator_issue_${timestamp}.png`,
      contentType: 'image/png',
    });

    const diagUploadRes = await axios.post(`${API}/media/job-diagnostics`, clientForm, {
      headers: {
        Authorization: `Bearer ${clientToken}`,
        ...clientForm.getHeaders(),
      },
    });

    const diagnosticCdnUrl = diagUploadRes.data[0].cdnUrl;
    console.log(`   ✅ Diagnostic photo stored in R2: ${diagnosticCdnUrl}`);

    // 3. Client creates Job with mediaUrls attached
    console.log('\n3. Client creating Job with diagnostic mediaUrls attached...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Generator Coil Rewinding',
        description: 'Coil burnt during load surge. Diagnostic photo attached.',
        category: 'Electrical',
        location: 'Ibadan, Oyo State',
        budget: 45000,
        tranche1Amount: 20000,
        tranche2Amount: 25000,
        mediaUrls: [diagnosticCdnUrl],
      },
      {
        headers: { Authorization: `Bearer ${clientToken}` },
      },
    );
    const createdJob = jobRes.data;
    console.log(`   ✅ Job created successfully (ID: ${createdJob.id}).`);
    console.log('   Attached mediaUrls on Job:', createdJob.mediaUrls);

    // 4. Artisan uploads completed repair Proof of Work
    console.log('\n4. Artisan uploading Proof of Work to /media/proof-of-work...');
    const artisanForm = new FormData();
    artisanForm.append('files', dummyImageBuffer, {
      filename: `repair_completed_${timestamp}.png`,
      contentType: 'image/png',
    });

    const powUploadRes = await axios.post(`${API}/media/proof-of-work`, artisanForm, {
      headers: {
        Authorization: `Bearer ${artisanToken}`,
        ...artisanForm.getHeaders(),
      },
    });

    const proofCdnUrl = powUploadRes.data[0].cdnUrl;
    console.log(`   ✅ Proof of Work stored in R2: ${proofCdnUrl}`);

    console.log('\n========================================');
    console.log('🎉 FULL MEDIA LIFECYCLE VERIFIED:');
    console.log('Job ID:             ', createdJob.id);
    console.log('Diagnostic Photo:   ', createdJob.mediaUrls[0]);
    console.log('Proof of Work Photo:', proofCdnUrl);
    console.log('========================================');
  } catch (err) {
    console.error('❌ Lifecycle failed:', err.response?.data || err.message);
  }
}

runFullLifecycle();
