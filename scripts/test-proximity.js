const axios = require('axios');

const API = 'http://localhost:3000';

async function testProximity() {
  const timestamp = Date.now();
  console.log('🌍 Testing Tark Artisan Profile & Proximity Matching...\n');

  try {
    // 1. Fetch Categories
    console.log('1. Fetching active categories...');
    const catRes = await axios.get(`${API}/categories`);
    console.log(`   ✅ Loaded ${catRes.data.length} categories.`);
    console.log(`   Sample: ${catRes.data.slice(0, 3).map(c => c.name).join(', ')}`);

    // 2. Register Artisan
    const artisanEmail = `artisan_geo_${timestamp}@test.com`;
    console.log(`\n2. Registering Artisan (${artisanEmail})...`);
    const authRes = await axios.post(`${API}/auth/register`, {
      email: artisanEmail,
      password: 'Password123!',
      fullName: 'Tunde Solar Expert',
      role: 'artisan',
    });
    const token = authRes.data.accessToken;

    // 3. Update Profile with Skills & GPS Coordinates (Yaba, Lagos: 6.5180, 3.3725)
    console.log('3. Updating Artisan profile with coordinates & skills...');
    const profileRes = await axios.patch(
      `${API}/users/profile`,
      {
        phoneNumber: '+2348012345678',
        skills: ['solar-inverter', 'electrical'],
        latitude: 6.5180,
        longitude: 3.3725,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    console.log(`   ✅ Profile updated!`);
    console.log(`   Skills: ${JSON.stringify(profileRes.data.skills)}`);
    console.log(`   Location: Lat ${profileRes.data.latitude}, Lng ${profileRes.data.longitude}`);

    // 4. Query Nearby Artisans from Akoka, Lagos (6.5158, 3.3898) ~ 1.9km away
    console.log('\n4. Searching for nearby artisans from Akoka (6.5158, 3.3898)...');
    const searchRes = await axios.get(`${API}/users/artisans/nearby`, {
      params: {
        lat: 6.5158,
        lng: 3.3898,
        radiusKm: 10,
        category: 'solar-inverter',
      },
    });

    console.log(`   ✅ Found ${searchRes.data.length} matching artisan(s):`);
    searchRes.data.forEach(a => {
      console.log(`   - ${a.fullName} | Distance: ${a.distanceKm} km | Phone: ${a.phoneNumber}`);
    });

    console.log('\n✨ Proximity & Profile matching verified successfully!');
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

testProximity();
