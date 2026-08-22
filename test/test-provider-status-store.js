const { ensureProviderStatusTable, saveProviderStatus } = require('../index.js');
async function test(){
  await ensureProviderStatusTable();
  await saveProviderStatus('4KHDHub', {up:true, streamsFound:3, latencyMs:4200, titles:['Oppenheimer'], updatedAt: Date.now()});
  const r=await (require('../index.js').getProviderStatus('4KHDHub'));
  console.assert(r && r.up===true, 'expected up===true');
  console.assert(r.streamsFound===3, 'expected streamsFound===3');
  console.assert(r.latencyMs===4200, 'expected latencyMs===4200');
  console.log('[test-provider-status-store] PASS', r);
  process.exit(0);
}
test().catch(e=>{ console.error('[test-provider-status-store] FAIL', e); process.exit(1); });
