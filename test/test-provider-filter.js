const providerLoader = require('../providerLoader');

(async () => {
  const repo = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';
  const providers = await providerLoader.loadProviders(repo);
  console.log(`Loaded ${providers.length} providers from D3adlyRocket`);

  // Exact filter logic from index.js
  const config = {
    disabled: [
      'AllAnime', '🌟 All-Wish', 'AnimeKai', 'AnikotoTV', 'AnimePahe', 'AniDB', 'Animetsu',
      '🐍 Anime-Sama', 'AnimeZeY', 'HiAnime', 'Kurage', 'Movix VF', 'Nakios', '🌸 PersianStremio',
      'PlayIMDb', 'ShowBox', 'Purstream', 'TopCartoons', '🧲 Torrentio', '🫰 OnlyKDrama', 'XPass',
      '💋 Kisskh', 'HDFilme'
    ]
  };

  const filtered = providers.filter(p => !config.disabled.includes(p.name));
  const torrentio = providers.filter(p => /torrentio/i.test(p.name));
  const filteredTorrentio = filtered.filter(p => /torrentio/i.test(p.name));
  console.log(`After filter: ${filtered.length} providers`);
  console.log(`Torrentio in full list: ${torrentio.map(p=>JSON.stringify(p.name)).join(', ') || '(none)'}`);
  console.log(`Torrentio still ACTIVE after filter: ${filteredTorrentio.map(p=>JSON.stringify(p.name)).join(', ') || '(none)'}`);
  console.log(`VERDICT: ${filteredTorrentio.length === 0 ? 'PASS - disabled providers are excluded' : 'FAIL - disabled provider still active'}`);

  // Duplicate-name scenario: same addon under different name across repos
  const repo2 = 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json';
  const providers2 = await providerLoader.loadProviders(repo2);
  const castle2 = providers2.filter(p => /castle/i.test(p.name));
  console.log(`\n[Cross-repo name mismatch check]`);
  console.log(`  Castle in yoruix repo (not disabled): ${castle2.map(p=>JSON.stringify(p.name)).join(', ') || '(none)'}`);
})();
