const axios = require('axios');
const FormData = require('form-data');

const API = 'http://localhost:3000';

async function testRealMediaUpload() {
  const timestamp = Date.now();
  console.log('📸 Testing Real Cloudflare R2 Upload via iyke-storage...\n');

  try {
    // 1. Authenticate test client
    console.log('1. Authenticating test client...');
    const authRes = await axios.post(`${API}/auth/register`, {
      email: `uploader_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Media Tester',
      role: 'client',
    });
    const token = authRes.data.accessToken;
    console.log('   ✅ Client authenticated successfully.');

    // 2. Generate a valid 1x1 test PNG buffer
    const testPngBuffer = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a7df77e80000000049454e44ae426082',
      'hex',
    );

    // 3. Prepare multipart form payload
    const form = new FormData();
    form.append('files', testPngBuffer, {
      filename: `generator_diagnostic_${timestamp}.png`,
      contentType: 'image/png',
    });

    console.log('2. Uploading image to /media/job-diagnostics...');
    const uploadRes = await axios.post(`${API}/media/job-diagnostics`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    console.log('\n========================================');
    console.log('🎉 UPLOAD RESPONSE FROM IYKE-STORAGE:');
    console.log(JSON.stringify(uploadRes.data, null, 2));
    console.log('========================================');
  } catch (err) {
    console.error('\n❌ Upload failed:');
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error('Data:', err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

testRealMediaUpload();
