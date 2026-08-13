const axios = require('axios');

async function test() {
    try {
        const res = await axios.get('http://localhost:7000/manifest.json');
        console.log('Manifest:', res.data.id);

        // Try scraping a popular movie, e.g. Inception tt1375666
        const streamRes = await axios.get('http://localhost:7000/stream/movie/tt1375666.json', { timeout: 20000 });
        const streams = streamRes.data.streams;
        console.log(`Found ${streams.length} streams.`);
        if (streams.length > 0) {
            console.log('Sample stream:', JSON.stringify(streams[1] || streams[0], null, 2));
        } else {
            console.log('No streams found. The addon returned an empty array.');
        }
    } catch (e) {
        console.error('Error testing addon:', e.message);
    }
}
test();
