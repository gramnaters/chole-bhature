const providerLoader = require('./providerLoader');
const url = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';

async function test() {
    try {
        console.log('Loading providers from', url);
        const providers = await providerLoader.loadProviders(url);
        console.log(`Loaded ${providers.length} providers.`);
        
        const hdhub = providers.find(p => p.name.toLowerCase().includes('hdhub'));
        if (!hdhub) {
            console.log('HdHub provider not found!');
            return;
        }
        
        console.log(`Testing ${hdhub.name} for Inception (tt1375666)...`);
        // getStreams(tmdbId, type, season, episode, config)
        // Inception TMDB ID: 27205
        const streams = await hdhub.getStreams('27205', 'movie', null, null, {});
        console.log(`HdHub returned ${streams.length} streams.`);
        if (streams.length > 0) {
            console.log(streams[0]);
        }
    } catch (e) {
        console.error('Error:', e);
    }
}
test();
