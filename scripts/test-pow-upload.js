const axios = require('axios');
const FormData = require('form-data');

const API = 'http://localhost:3000';

async function testPowUpload() {
  try {
    const authRes = await axios.post(`${API}/auth/register`, {
      email: `artisan_${Date.now()}@test.com`,
      password: 'Password123!',
      fullName: 'Handshake Artisan',
      role: 'artisan',
    });
    const token = authRes.data.accessToken;

    const testPngBuffer = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a7df77e80000000049454e44ae426082',
      'hex',
    );

    const form = new FormData();
    form.append('files', testPngBuffer, {
      filename: `repair_completed_${Date.now()}.png`,
      contentType: 'image/png',
    });

    const res = await axios.post(`${API}/media/proof-of-work`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    console.log('✅ Proof of Work Upload Success:');
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('❌ PoW Upload Failed:', err.response?.data || err.message);
  }
}

testPowUpload();
